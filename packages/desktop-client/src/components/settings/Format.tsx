// @ts-strict-ignore
import React, { type ReactNode } from 'react';
import { useTranslation, Trans } from 'react-i18next';

import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { tokens } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { css } from '@emotion/css';

import { numberFormats } from 'loot-core/shared/util';
import { type SyncedPrefs } from 'loot-core/types/prefs';

import { Column, Setting } from './UI';

import { Checkbox } from '@desktop-client/components/forms';
import { useSidebar } from '@desktop-client/components/sidebar/SidebarProvider';
import { useDateFormat } from '@desktop-client/hooks/useDateFormat';
import { useSyncedPref } from '@desktop-client/hooks/useSyncedPref';

// Follows Pikaday 'firstDay' numbering
// https://github.com/Pikaday/Pikaday
function useDaysOfWeek(firstDayIdx: string = '0') {
  const { t } = useTranslation();

  const allDays: {
    value: SyncedPrefs['firstDayOfWeekIdx'];
    label: string;
  }[] = [
    { value: '0', label: t('Sunday') },
    { value: '1', label: t('Monday') },
    { value: '2', label: t('Tuesday') },
    { value: '3', label: t('Wednesday') },
    { value: '4', label: t('Thursday') },
    { value: '5', label: t('Friday') },
    { value: '6', label: t('Saturday') },
  ] as const;

  // Rearrange days to start with the selected first day
  const firstDayIndex = parseInt(firstDayIdx, 10);
  const daysOfWeek = [
    ...allDays.slice(firstDayIndex),
    ...allDays.slice(0, firstDayIndex)
  ];

  return { daysOfWeek };
}
const dateFormats: { value: SyncedPrefs['dateFormat']; label: string }[] = [
  { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY' },
  { value: 'dd/MM/yyyy', label: 'DD/MM/YYYY' },
  { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD' },
  { value: 'MM.dd.yyyy', label: 'MM.DD.YYYY' },
  { value: 'dd.MM.yyyy', label: 'DD.MM.YYYY' },
];

export function FormatSettings() {
  const { t } = useTranslation();

  const sidebar = useSidebar();
  const [_firstDayOfWeekIdx, setFirstDayOfWeekIdxPref] =
    useSyncedPref('firstDayOfWeekIdx'); // Sunday;
  const firstDayOfWeekIdx = _firstDayOfWeekIdx || '0';
  const [_weekendDays, setWeekendDaysPref] = useSyncedPref('weekendDays');
  const weekendDays = _weekendDays 
    ? (_weekendDays === 'none' ? [] : _weekendDays.split(',').filter(Boolean))
    : ['0', '6']; // Default to Sunday and Saturday for new users
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const [, setDateFormatPref] = useSyncedPref('dateFormat');
  const [_numberFormat, setNumberFormatPref] = useSyncedPref('numberFormat');
  const numberFormat = _numberFormat || 'comma-dot';
  const [hideFraction, setHideFractionPref] = useSyncedPref('hideFraction');

  const { daysOfWeek } = useDaysOfWeek(firstDayOfWeekIdx);

  const handleWeekendDayToggle = (dayValue: string) => {
    const isCurrentlySelected = weekendDays.includes(dayValue);

    if (isCurrentlySelected) {
      // Remove the day
      const newWeekendDays = weekendDays.filter(day => day !== dayValue);
      setWeekendDaysPref(newWeekendDays.length > 0 ? newWeekendDays.join(',') : 'none');
    } else {
      // Add the day
      const newWeekendDays = [...weekendDays, dayValue];
      setWeekendDaysPref(newWeekendDays.join(','));
    }
  };

  const selectButtonClassName = css({
    '&[data-hovered]': {
      backgroundColor: theme.buttonNormalBackgroundHover,
    },
  });

  return (
    <Setting
      primaryAction={
        <View
          style={{
            flexDirection: 'column',
            gap: '1.5em',
            width: '100%',
          }}
        >
          {/* First row: Numbers, Dates, First day of the week */}
          <View
            style={{
              flexDirection: 'column',
              gap: '1em',
              width: '100%',
              [`@media (min-width: ${
                sidebar.floating
                  ? tokens.breakpoint_small
                  : tokens.breakpoint_medium
              })`]: {
                flexDirection: 'row',
              },
            }}
          >
            <Column title={t('Numbers')}>
              <Select
                key={String(hideFraction)} // needed because label does not update
                value={numberFormat}
                onChange={format => setNumberFormatPref(format)}
                options={numberFormats.map(f => [
                  f.value,
                  String(hideFraction) === 'true' ? f.labelNoFraction : f.label,
                ])}
                className={selectButtonClassName}
              />

              <Text style={{ display: 'flex' }}>
                <Checkbox
                  id="settings-textDecimal"
                  checked={String(hideFraction) === 'true'}
                  onChange={e =>
                    setHideFractionPref(String(e.currentTarget.checked))
                  }
                />
                <label htmlFor="settings-textDecimal">
                  <Trans>Hide decimal places</Trans>
                </label>
              </Text>
            </Column>

            <Column title={t('Dates')}>
              <Select
                value={dateFormat}
                onChange={format => setDateFormatPref(format)}
                options={dateFormats.map(f => [f.value, f.label])}
                className={selectButtonClassName}
              />
            </Column>

            <Column title={t('First day of the week')}>
              <Select
                value={firstDayOfWeekIdx}
                onChange={idx => setFirstDayOfWeekIdxPref(idx)}
                options={daysOfWeek.map(f => [f.value, f.label])}
                className={selectButtonClassName}
              />
            </Column>
          </View>

          {/* Second row: Weekend days */}
          <View
            style={{
              width: '100%',
            }}
          >
            <Column title={t('Weekend days')}>
              <View
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  gap: '0.5em',
                }}
              >
                {daysOfWeek.map(day => {
                  const isChecked = weekendDays.includes(day.value);
                  const dayShort = day.label.slice(0, 3);

                  return (
                    <View
                      key={day.value}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleWeekendDayToggle(day.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleWeekendDayToggle(day.value);
                        }
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        border: `2px solid ${isChecked ? theme.pageTextPositive : theme.buttonNormalBorder}`,
                        backgroundColor: isChecked ? theme.pageTextPositive + '20' : theme.buttonNormalBackground,
                        color: isChecked ? theme.pageTextPositive : theme.pageText,
                        cursor: 'pointer',
                        userSelect: 'none',
                        width: '52px',
                        height: '36px',
                        fontSize: '14px',
                        fontWeight: '500',
                        transition: 'background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease',
                        '&:hover': {
                          backgroundColor: isChecked
                            ? theme.pageTextPositive + '30'
                            : theme.buttonNormalBackgroundHover,
                        },
                        '&:focus': {
                          outline: `2px solid ${theme.pageTextPositive}`,
                          outlineOffset: '2px',
                        },
                      }}
                      className={css({
                        '&:hover': {
                          backgroundColor: isChecked
                            ? theme.pageTextPositive + '30'
                            : theme.buttonNormalBackgroundHover,
                        },
                        '&:focus': {
                          outline: `2px solid ${theme.pageTextPositive}`,
                          outlineOffset: '2px',
                        },
                      })}
                    >
                      {dayShort}
                    </View>
                  );
                })}
              </View>
            </Column>
          </View>
        </View>
      }
    >
      <Text>
        <Trans>
          <strong>Formatting</strong> does not affect how budget data is stored,
          and can be changed at any time.
        </Trans>
      </Text>
    </Setting>
  );
}
