import { getDisplayProcessor } from '../../../field/displayProcessor';
import { createTheme } from '../../../themes/createTheme';
import { type Field, type FieldConfig } from '../../../types/dataFrame';
import { type ValueMatcherInfo } from '../../../types/transformations';
import { formattedValueToString } from '../../../valueFormats/baseFormatters';

export interface TableValueOptions {
  values?: string[];
  range?: { min?: number; max?: number; includeMissing: boolean };
  displayConfig?: FieldConfig;
  timeZone?: string;
}

const fallbackTheme = createTheme();

export const tableViewMatcher: ValueMatcherInfo<TableValueOptions> = {
  id: 'tableViewValue',
  name: 'Table view value',
  description: 'Matches a transient table value selection or numeric range.',
  isApplicable: () => false,
  getDefaultOptions: () => ({ values: [] }),
  get: (options) => {
    const selected = new Set(options.values);
    const displays = new WeakMap<Field, ReturnType<typeof getDisplayProcessor>>();
    return (index, field) => {
      const value = field.values[index];
      if (options.range) {
        const { min, max, includeMissing } = options.range;
        return typeof value !== 'number' || !Number.isFinite(value)
          ? includeMissing
          : (min == null || value >= min) && (max == null || value <= max);
      }
      let display = displays.get(field);
      if (!display) {
        display = options.displayConfig
          ? getDisplayProcessor({
              theme: fallbackTheme,
              field: { ...field, config: options.displayConfig },
              timeZone: options.timeZone,
            })
          : (field.display ?? getDisplayProcessor({ theme: fallbackTheme, field, timeZone: options.timeZone }));
        displays.set(field, display);
      }
      return selected.has(formattedValueToString(display(value)));
    };
  },
  getOptionsDisplayText: () => 'Table view selection',
};
