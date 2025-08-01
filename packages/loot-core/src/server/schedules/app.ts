// @ts-strict-ignore
import * as d from 'date-fns';
import deepEqual from 'deep-equal';
import { v4 as uuidv4 } from 'uuid';

import { captureBreadcrumb } from '../../platform/exceptions';
import * as connection from '../../platform/server/connection';
import { currentDay, dayFromDate, parseDate } from '../../shared/months';
import { q } from '../../shared/query';
import {
  extractScheduleConds,
  getDateWithSkippedWeekend,
  getHasTransactionsQuery,
  getNextDate,
  getScheduledAmount,
  getStatus,
  recurConfigToRSchedule,
} from '../../shared/schedules';
import { ScheduleEntity } from '../../types/models';
import { addTransactions } from '../accounts/sync';
import { createApp } from '../app';
import { aqlQuery } from '../aql';
import * as db from '../db';
import { toDateRepr } from '../models';
import { mutator, runMutator } from '../mutators';
import * as prefs from '../prefs';
import { Rule } from '../rules';
import { addSyncListener, batchMessages } from '../sync';
import {
  getRules,
  insertRule,
  ruleModel,
  updateRule,
} from '../transactions/transaction-rules';
import { undoable } from '../undo';
import { Schedule as RSchedule } from '../util/rschedule';

import { findSchedules } from './find-schedules';

// Utilities

async function getWeekendDays(): Promise<string[]> {
  const { data: weekendDaysData } = await aqlQuery(
    q('preferences').filter({ id: 'weekendDays' }).select('value'),
  );

  const weekendDaysValue = weekendDaysData[0]?.value;
  if (weekendDaysValue === 'none') {
    return [];
  }
  return weekendDaysValue ? weekendDaysValue.split(',').filter(Boolean) : ['0', '6']; // Default to Sunday and Saturday
}

function zip(arr1, arr2) {
  const result = [];
  for (let i = 0; i < arr1.length; i++) {
    result.push([arr1[i], arr2[i]]);
  }
  return result;
}

export function updateConditions(conditions, newConditions) {
  const scheduleConds = extractScheduleConds(conditions);
  const newScheduleConds = extractScheduleConds(newConditions);

  const replacements = zip(
    Object.values(scheduleConds),
    Object.values(newScheduleConds),
  );

  const updated = conditions.map(cond => {
    const r = replacements.find(r => cond === r[0]);
    return r && r[1] ? r[1] : cond;
  });

  const added = replacements
    .filter(x => x[0] == null && x[1] != null)
    .map(x => x[1]);

  return updated.concat(added);
}

export async function getRuleForSchedule(id: string | null): Promise<Rule> {
  if (id == null) {
    throw new Error('Schedule not attached to a rule');
  }

  const { data: ruleId } = await aqlQuery(
    q('schedules').filter({ id }).calculate('rule'),
  );
  return getRules().find(rule => rule.id === ruleId);
}

async function fixRuleForSchedule(id) {
  const { data: ruleId } = await aqlQuery(
    q('schedules').filter({ id }).calculate('rule'),
  );

  if (ruleId) {
    // Take the bad rule out of the system so it never causes problems
    // in the future
    await db.delete_('rules', ruleId);
  }

  const newId = await insertRule({
    stage: null,
    conditionsOp: 'and',
    conditions: [
      { op: 'isapprox', field: 'date', value: currentDay() },
      { op: 'isapprox', field: 'amount', value: 0 },
    ],
    actions: [{ op: 'link-schedule', value: id }],
  });

  await db.updateWithSchema('schedules', { id, rule: newId });

  return getRules().find(rule => rule.id === newId);
}

export async function setNextDate({
  id,
  start,
  conditions,
  reset,
}: {
  id: string;
  start?;
  conditions?;
  reset?: boolean;
}) {
  if (conditions == null) {
    const rule = await getRuleForSchedule(id);
    if (rule == null) {
      throw new Error('No rule found for schedule');
    }
    conditions = rule.serialize().conditions;
  }

  const { date: dateCond } = extractScheduleConds(conditions);

  const { data: nextDate } = await aqlQuery(
    q('schedules').filter({ id }).calculate('next_date'),
  );

  // Only do this if a date condition exists
  if (dateCond) {
    const weekendDays = await getWeekendDays();
    const newNextDate = getNextDate(
      dateCond,
      start ? start(nextDate) : new Date(),
      false,
      weekendDays,
    );

    if (newNextDate !== nextDate) {
      // Our `update` functon requires the id of the item and we don't
      // have it, so we need to query it
      const nd = await db.first<
        Pick<db.DbScheduleNextDate, 'id' | 'base_next_date_ts'>
      >(
        'SELECT id, base_next_date_ts FROM schedules_next_date WHERE schedule_id = ?',
        [id],
      );

      await db.update(
        'schedules_next_date',
        reset
          ? {
              id: nd.id,
              base_next_date: toDateRepr(newNextDate),
              base_next_date_ts: Date.now(),
            }
          : {
              id: nd.id,
              local_next_date: toDateRepr(newNextDate),
              local_next_date_ts: nd.base_next_date_ts,
            },
      );
    }
  }
}

// Methods

async function checkIfScheduleExists(name, scheduleId) {
  const idForName = await db.first<Pick<db.DbSchedule, 'id'>>(
    'SELECT id from schedules WHERE tombstone = 0 AND name = ?',
    [name],
  );

  if (idForName == null) {
    return false;
  }
  if (scheduleId) {
    return idForName['id'] !== scheduleId;
  }
  return true;
}

export async function createSchedule({
  schedule = null,
  conditions = [],
} = {}): Promise<ScheduleEntity['id']> {
  const scheduleId = schedule?.id || uuidv4();

  const { date: dateCond } = extractScheduleConds(conditions);
  if (dateCond == null) {
    throw new Error('A date condition is required to create a schedule');
  }
  if (dateCond.value == null) {
    throw new Error('Date is required');
  }

  const weekendDays = await getWeekendDays();
  const nextDate = getNextDate(dateCond, undefined, false, weekendDays);
  const nextDateRepr = nextDate ? toDateRepr(nextDate) : null;
  if (schedule) {
    if (schedule.name) {
      if (await checkIfScheduleExists(schedule.name, scheduleId)) {
        throw new Error('Cannot create schedules with the same name');
      }
    } else {
      schedule.name = null;
    }
  }

  // Create the rule here based on the info
  const ruleId = await insertRule({
    stage: null,
    conditionsOp: 'and',
    conditions,
    actions: [{ op: 'link-schedule', value: scheduleId }],
  });

  const now = Date.now();
  await db.insertWithUUID('schedules_next_date', {
    schedule_id: scheduleId,
    local_next_date: nextDateRepr,
    local_next_date_ts: now,
    base_next_date: nextDateRepr,
    base_next_date_ts: now,
  });

  await db.insertWithSchema('schedules', {
    ...schedule,
    id: scheduleId,
    rule: ruleId,
  });

  return scheduleId;
}

// TODO: don't allow deleting rules that link schedules

export async function updateSchedule({
  schedule,
  conditions,
  resetNextDate,
}: {
  schedule;
  conditions?;
  resetNextDate?: boolean;
}) {
  if (schedule.rule) {
    throw new Error('You cannot change the rule of a schedule');
  }
  let rule;

  // This must be outside the `batchMessages` call because we change
  // and then read data
  if (conditions) {
    const { date: dateCond } = extractScheduleConds(conditions);
    if (dateCond && dateCond.value == null) {
      throw new Error('Date is required');
    }

    // We need to get the full rule to merge in the updated
    // conditions
    rule = await getRuleForSchedule(schedule.id);

    if (rule == null) {
      // In the edge case that a rule gets corrupted (either by a bug in
      // the system or user messing with their data), don't crash. We
      // generate a new rule because schedules have to have a rule
      // attached to them.
      rule = await fixRuleForSchedule(schedule.id);
    }
  }

  await batchMessages(async () => {
    if (conditions) {
      const oldConditions = rule.serialize().conditions;
      const newConditions = updateConditions(oldConditions, conditions);

      await updateRule({ id: rule.id, conditions: newConditions });

      // Annoyingly, sometimes it has `type` and sometimes it doesn't
      const stripType = ({ type, ...fields }) => fields;

      // Update `next_date` if the user forced it, or if the account
      // or date changed. We check account because we don't update
      // schedules automatically for closed account, and the user
      // might switch accounts from a closed one
      if (
        resetNextDate ||
        !deepEqual(
          oldConditions.find(c => c.field === 'account'),
          oldConditions.find(c => c.field === 'account'),
        ) ||
        !deepEqual(
          stripType(oldConditions.find(c => c.field === 'date') || {}),
          stripType(newConditions.find(c => c.field === 'date') || {}),
        )
      ) {
        await setNextDate({
          id: schedule.id,
          conditions: newConditions,
          reset: true,
        });
      }
    } else if (resetNextDate) {
      await setNextDate({ id: schedule.id, reset: true });
    }

    await db.updateWithSchema('schedules', schedule);
  });

  return schedule.id;
}

export async function deleteSchedule({ id }) {
  const { data: ruleId } = await aqlQuery(
    q('schedules').filter({ id }).calculate('rule'),
  );

  await batchMessages(async () => {
    await db.delete_('rules', ruleId);
    await db.delete_('schedules', id);
  });
}

async function skipNextDate({ id }) {
  return setNextDate({
    id,
    start: nextDate => {
      return d.addDays(parseDate(nextDate), 1);
    },
  });
}

function discoverSchedules() {
  return findSchedules();
}

async function getUpcomingDates({ config, count }) {
  const rules = recurConfigToRSchedule(config);

  try {
    const schedule = new RSchedule({ rrules: rules });
    const weekendDays = await getWeekendDays();

    return schedule
      .occurrences({ start: d.startOfDay(new Date()), take: count })
      .toArray()
      .map(date =>
        config.skipWeekend
          ? getDateWithSkippedWeekend(
              date.date,
              config.weekendSolveMode,
              weekendDays,
            )
          : date.date,
      )
      .map(date => dayFromDate(date));
  } catch (err) {
    captureBreadcrumb(config);
    throw err;
  }
}

// Services

function onRuleUpdate(rule) {
  const { actions, conditions } =
    rule instanceof Rule ? rule.serialize() : ruleModel.toJS(rule);

  if (actions && actions.find(a => a.op === 'link-schedule')) {
    const scheduleId = actions.find(a => a.op === 'link-schedule').value;

    if (scheduleId) {
      const conds = extractScheduleConds(conditions);

      const payeeIdx = conditions.findIndex(c => c === conds.payee);
      const accountIdx = conditions.findIndex(c => c === conds.account);
      const amountIdx = conditions.findIndex(c => c === conds.amount);
      const dateIdx = conditions.findIndex(c => c === conds.date);

      db.runQuery(
        'INSERT OR REPLACE INTO schedules_json_paths (schedule_id, payee, account, amount, date) VALUES (?, ?, ?, ?, ?)',
        [
          scheduleId,
          payeeIdx === -1 ? null : `$[${payeeIdx}]`,
          accountIdx === -1 ? null : `$[${accountIdx}]`,
          amountIdx === -1 ? null : `$[${amountIdx}]`,
          dateIdx === -1 ? null : `$[${dateIdx}]`,
        ],
      );
    }
  }
}

function trackJSONPaths() {
  // Populate the table
  db.transaction(() => {
    getRules().forEach(rule => {
      onRuleUpdate(rule);
    });
  });

  return addSyncListener(onApplySync);
}

function onApplySync(oldValues, newValues) {
  newValues.forEach((items, table) => {
    if (table === 'rules') {
      items.forEach(newValue => {
        onRuleUpdate(newValue);
      });
    }
  });
}

// This is the service that move schedules forward automatically and
// posts transactions

async function postTransactionForSchedule({ id }: { id: string }) {
  const { data } = await aqlQuery(q('schedules').filter({ id }).select('*'));
  const schedule = data[0];
  if (schedule == null || schedule._account == null) {
    return;
  }

  const transaction = {
    payee: schedule._payee,
    account: schedule._account,
    amount: getScheduledAmount(schedule._amount),
    date: currentDay(),
    schedule: schedule.id,
    cleared: false,
  };

  if (transaction.account) {
    await addTransactions(transaction.account, [transaction]);
  }
}

// TODO: make this sequential

async function advanceSchedulesService(syncSuccess) {
  // Move all paid schedules
  const { data: schedules } = await aqlQuery(
    q('schedules')
      .filter({ completed: false, '_account.closed': false })
      .select('*'),
  );
  const { data: hasTransData } = await aqlQuery(
    getHasTransactionsQuery(schedules),
  );
  const hasTrans = new Set(
    hasTransData.filter(Boolean).map(row => row.schedule),
  );

  const failedToPost = [];
  let didPost = false;

  const { data: upcomingLength } = await aqlQuery(
    q('preferences')
      .filter({ id: 'upcomingScheduledTransactionLength' })
      .select('value'),
  );

  for (const schedule of schedules) {
    const status = getStatus(
      schedule.next_date,
      schedule.completed,
      hasTrans.has(schedule.id),
      upcomingLength[0]?.value ?? '7',
    );

    if (status === 'paid') {
      if (schedule._date) {
        // Move forward recurring schedules
        if (schedule._date.frequency) {
          try {
            await setNextDate({ id: schedule.id });
          } catch (err) {
            // This might error if the rule is corrupted and it can't
            // find the rule
          }
        } else {
          if (schedule._date < currentDay()) {
            // Complete any single schedules
            await updateSchedule({
              schedule: { id: schedule.id, completed: true },
            });
          }
        }
      }
    } else if (
      (status === 'due' || status === 'missed') &&
      schedule.posts_transaction &&
      schedule._account
    ) {
      // Automatically create a transaction for due schedules
      if (syncSuccess) {
        await postTransactionForSchedule({ id: schedule.id });

        didPost = true;
      } else {
        failedToPost.push(schedule._payee);
      }
    }
  }

  if (failedToPost.length > 0) {
    connection.send('schedules-offline');
  } else if (didPost) {
    // This forces a full refresh of transactions because it
    // simulates them coming in from a full sync. This not a
    // great API right now, but I think generally the approach
    // is sane to treat them as external sync events.
    connection.send('sync-event', {
      type: 'success',
      tables: ['transactions'],
      syncDisabled: false,
    });
  }
}

export type SchedulesHandlers = {
  'schedule/create': typeof createSchedule;
  'schedule/update': typeof updateSchedule;
  'schedule/delete': typeof deleteSchedule;
  'schedule/skip-next-date': typeof skipNextDate;
  'schedule/post-transaction': typeof postTransactionForSchedule;
  'schedule/force-run-service': typeof advanceSchedulesService;
  'schedule/discover': typeof discoverSchedules;
  'schedule/get-upcoming-dates': typeof getUpcomingDates;
};

// Expose functions to the client
export const app = createApp<SchedulesHandlers>();

app.method('schedule/create', mutator(undoable(createSchedule)));
app.method('schedule/update', mutator(undoable(updateSchedule)));
app.method('schedule/delete', mutator(undoable(deleteSchedule)));
app.method('schedule/skip-next-date', mutator(undoable(skipNextDate)));
app.method(
  'schedule/post-transaction',
  mutator(undoable(postTransactionForSchedule)),
);
app.method(
  'schedule/force-run-service',
  mutator(() => advanceSchedulesService(true)),
);
app.method('schedule/discover', discoverSchedules);
app.method('schedule/get-upcoming-dates', getUpcomingDates);

app.service(trackJSONPaths);

app.events.on('sync', ({ type }) => {
  const completeEvent =
    type === 'success' || type === 'error' || type === 'unauthorized';

  if (completeEvent && prefs.getPrefs()) {
    const { lastScheduleRun } = prefs.getPrefs();

    if (lastScheduleRun !== currentDay()) {
      runMutator(() => advanceSchedulesService(type === 'success'));

      prefs.savePrefs({ lastScheduleRun: currentDay() });
    }
  }
});
