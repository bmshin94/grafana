import { isEqual } from 'lodash';
import { map, of } from 'rxjs';

import { getFieldDisplayName } from '../../field/fieldState';
import { type DataFrame, FieldType } from '../../types/dataFrame';
import { type DataTransformerConfig, type CustomTransformOperator } from '../../types/transformations';
import { type TableValueOptions } from '../matchers/valueMatchers/tableViewMatcher';

import { filterByValueTransformer, FilterByValueType, FilterByValueMatch } from './filterByValue';
import { sortByTransformer, type SortByField } from './sortBy';

export const TABLE_VIEW_TRANSFORM = 'tableView';
const tableSource = Symbol('tableViewSource');
type ViewFrame = DataFrame & { [tableSource]?: DataFrame };

export interface TableViewFilter extends TableValueOptions {
  displayName: string;
  fieldName?: string;
  fieldLabels?: Record<string, string>;
  parentIndex?: number;
  parentKey?: string;
  searchFilter?: string;
  operator?: string;
}
export interface TableViewOptions {
  frameKey: string;
  filters: Record<string, TableViewFilter>;
  sort: SortByField[];
}

/** Frame occurrence disambiguates query results sharing a refId and schema. */
export function tableFrameKey(frames: readonly DataFrame[], index: number): string {
  const signature = (frame: DataFrame) =>
    JSON.stringify([frame.refId, frame.name, frame.fields.map((field) => [field.name, field.type, field.labels])]);
  const frame = frames[index];
  if (!frame) {
    return '';
  }
  const key = signature(frame);
  const occurrence = frames.slice(0, index).filter((f) => signature(f) === key).length;
  return `${key}:${occurrence}`;
}

export function tableParentKey(frame: DataFrame, parentIndex: number): string {
  return JSON.stringify(
    frame.fields.filter((field) => field.type !== FieldType.nestedFrames).map((field) => field.values[parentIndex])
  );
}

export function getTableViewSource(frame: DataFrame): DataFrame {
  const view: ViewFrame = frame;
  return view[tableSource] ?? frame;
}

/** Eager built-in operators keep local table interactions synchronous, including in standalone packages. */
export function transformTableFrame(
  frame: DataFrame,
  filters: Record<string, TableViewFilter>,
  sort: SortByField[],
  parentIndex?: number
): DataFrame {
  const scoped = Object.values(filters).flatMap((filter) => {
    if (filter.parentIndex !== parentIndex) {
      return [];
    }
    const field = frame.fields.find((f) =>
      filter.fieldName
        ? f.name === filter.fieldName && isEqual(f.labels, filter.fieldLabels)
        : getFieldDisplayName(f, frame) === filter.displayName
    );
    return field ? [{ ...filter, displayName: getFieldDisplayName(field, frame) }] : [];
  });
  let output = frame;
  let failure: unknown;
  of([frame])
    .pipe(
      filterByValueTransformer.operator(
        {
          type: FilterByValueType.include,
          match: FilterByValueMatch.all,
          filters: scoped.map((filter) => ({
            fieldName: filter.displayName,
            config: { id: 'tableViewValue', options: filter },
          })),
        },
        { interpolate: (s) => s }
      ),
      sortByTransformer.operator({ sort, table: true }, { interpolate: (s) => s })
    )
    .subscribe({
      next: (frames) => {
        output = frames[0];
      },
      error: (error) => {
        failure = error;
      },
    });
  if (failure) {
    throw failure;
  }
  return output;
}

/** Select source indices through the same operators used by the dashboard stage. */
export function tableViewIndices(
  frame: DataFrame,
  filters: Record<string, TableViewFilter>,
  sort: SortByField[],
  parentIndex?: number
): number[] {
  let name = '__table_view_index';
  while (frame.fields.some((field) => field.name === name)) {
    name += '_';
  }
  const indexField = {
    name,
    type: FieldType.number,
    config: {},
    values: Array.from({ length: frame.length }, (_, i) => i),
  };
  const result = transformTableFrame({ ...frame, fields: [...frame.fields, indexField] }, filters, sort, parentIndex);
  return result.fields[result.fields.length - 1].values;
}

export function tableViewOperator(options: TableViewOptions): CustomTransformOperator {
  return () => (source) =>
    source.pipe(
      map((frames) =>
        frames.map((frame, index) => {
          if (tableFrameKey(frames, index) !== options.frameKey) {
            return frame;
          }
          const nested = {
            ...frame,
            fields: frame.fields.map((field) =>
              field.type !== FieldType.nestedFrames
                ? field
                : {
                    ...field,
                    values: field.values.map((children: DataFrame[] | undefined, parentIndex: number) =>
                      children?.map((child) =>
                        transformTableFrame(
                          child,
                          Object.fromEntries(
                            Object.entries(options.filters).filter(
                              ([, filter]) =>
                                filter.parentKey == null || filter.parentKey === tableParentKey(frame, parentIndex)
                            )
                          ),
                          options.sort,
                          parentIndex
                        )
                      )
                    ),
                  }
            ),
          };
          const result: ViewFrame = transformTableFrame(nested, options.filters, options.sort);
          // Symbols survive field organization and override frame copies, but never serialize into exports.
          return { ...result, [tableSource]: frame };
        })
      )
    );
}

export function resolveTableViewTransform(
  config: DataTransformerConfig
): DataTransformerConfig | CustomTransformOperator {
  return config.id === TABLE_VIEW_TRANSFORM && !config.disabled ? tableViewOperator(config.options) : config;
}
