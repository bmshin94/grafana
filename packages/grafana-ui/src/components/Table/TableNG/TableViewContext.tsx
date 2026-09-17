import { isEqual } from 'lodash';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { type DataFrame, type DataTransformerConfig, type Field, cacheFieldDisplayNames } from '@grafana/data';
import {
  TABLE_VIEW_TRANSFORM,
  tableFrameKey,
  tableParentKey,
  tableViewIndices,
  type TableViewFilter,
  type TableViewOptions,
} from '@grafana/data/internal';
import { selectors } from '@grafana/e2e-selectors';
import { t } from '@grafana/i18n';
import { type SortColumn } from '@grafana/react-data-grid';

import { Button } from '../../Button/Button';
import { ErrorBoundary } from '../../ErrorBoundary/ErrorBoundary';
import { type AdHocTransformationsApi } from '../../PanelChrome/PanelContext';

import { type FilterType, type TableNGProps, type TableRow, FilterOperator } from './types';
import { type ApplyFilterResult } from './utils';

export interface TableRowTransformations {
  api: AdHocTransformationsApi;
  frameKey: string;
}
interface ViewContext {
  filter: FilterType;
  setFilter: Dispatch<SetStateAction<FilterType>>;
  sortColumns: SortColumn[];
  setSortColumns: Dispatch<SetStateAction<SortColumn[]>>;
  timeZone?: string;
}
export const TableViewContext = createContext<ViewContext | undefined>(undefined);
export const useTableView = () => useContext(TableViewContext);
const EMPTY_STAGE: readonly DataTransformerConfig[] = [];

export function encodeTableFilters(filter: FilterType, timeZone?: string): Record<string, TableViewFilter> {
  return Object.fromEntries(
    Object.entries(filter).map(([key, entry]) => [
      key,
      {
        displayName: entry.displayName,
        fieldName: entry.fieldName,
        fieldLabels: entry.fieldLabels,
        parentIndex: entry.parentIndex,
        values: entry.range ? undefined : Array.from(entry.filteredSet),
        range: entry.range,
        displayConfig: entry.displayConfig,
        searchFilter: entry.searchFilter,
        operator: entry.operator?.value,
        timeZone,
      },
    ])
  );
}

function decodeFilters(filters: Record<string, TableViewFilter>): FilterType {
  return Object.fromEntries(
    Object.entries(filters).map(([key, entry]) => [
      key,
      {
        ...entry,
        filteredSet: new Set(entry.values ?? []),
        filtered: (entry.values ?? []).map((value) => ({ value, label: value })),
        operator: entry.operator
          ? {
              value: Object.values(FilterOperator).find((operator) => operator === entry.operator),
              label: entry.operator,
            }
          : undefined,
      },
    ])
  );
}

export function TableViewProvider({ props, children }: { props: TableNGProps; children: React.ReactNode }) {
  const api = props.rowTransformations?.api;
  const source = props.data;
  const frameKey = props.rowTransformations?.frameKey ?? tableFrameKey([source], 0);
  const stage = useSyncExternalStore(
    useCallback((listener) => api?.subscribe(listener) ?? (() => {}), [api]),
    useCallback(() => api?.get() ?? EMPTY_STAGE, [api])
  );
  const [local, setLocal] = useState<TableViewOptions>();
  const initialSort = useRef(props.sortBy);
  const initial = useMemo<TableViewOptions>(
    () => ({
      frameKey,
      filters: {},
      sort: (initialSort.current ?? []).map((s) => ({ field: s.displayName, desc: s.desc })),
    }),
    [frameKey]
  );
  const stored = stage.find((c) => c.id === TABLE_VIEW_TRANSFORM && c.options.frameKey === frameKey)?.options;
  const options: TableViewOptions = stored ?? (local?.frameKey === frameKey ? local : initial);
  const update = useCallback(
    (fn: (current: TableViewOptions) => TableViewOptions) => {
      if (!api) {
        setLocal((current) => {
          const previous = current?.frameKey === frameKey ? current : initial;
          const next = fn(previous);
          return isEqual(previous, next) ? previous : next;
        });
        return;
      }
      const configs = api.get();
      const current =
        configs.find((c) => c.id === TABLE_VIEW_TRANSFORM && c.options.frameKey === frameKey)?.options ?? initial;
      const next = fn(current);
      if (isEqual(current, next)) {
        return;
      }
      // Row transforms precede organize so hidden fields remain available to predicates and sort keys.
      const rest = configs.filter((c) => !(c.id === TABLE_VIEW_TRANSFORM && c.options.frameKey === frameKey));
      api.set([{ id: TABLE_VIEW_TRANSFORM, options: next }, ...rest]);
    },
    [api, frameKey, initial]
  );
  const filter = useMemo(
    () =>
      decodeFilters(
        Object.fromEntries(
          Object.entries(options.filters).filter(
            ([, entry]) =>
              entry.parentIndex == null ||
              entry.parentKey == null ||
              entry.parentKey === tableParentKey(source, entry.parentIndex)
          )
        )
      ),
    [options.filters, source]
  );
  const sortColumns = useMemo<SortColumn[]>(
    () => options.sort.map((s) => ({ columnKey: s.displayName ?? s.field, direction: s.desc ? 'DESC' : 'ASC' })),
    [options.sort]
  );
  const setFilter = useCallback<Dispatch<SetStateAction<FilterType>>>(
    (action) =>
      update((current) => {
        const previous = decodeFilters(
          Object.fromEntries(
            Object.entries(current.filters).filter(
              ([, entry]) =>
                entry.parentIndex == null ||
                entry.parentKey == null ||
                entry.parentKey === tableParentKey(source, entry.parentIndex)
            )
          )
        );
        const next = typeof action === 'function' ? action(previous) : action;
        return {
          ...current,
          filters: Object.fromEntries(
            Object.entries(encodeTableFilters(next, props.timeZone)).map(([key, entry]) => [
              key,
              {
                ...entry,
                parentKey: entry.parentIndex == null ? undefined : tableParentKey(source, entry.parentIndex),
              },
            ])
          ),
        };
      }),
    [update, props.timeZone, source]
  );
  const setSortColumns = useCallback<Dispatch<SetStateAction<SortColumn[]>>>(
    (action) =>
      update((current) => {
        const previous: SortColumn[] = current.sort.map((s) => ({
          columnKey: s.displayName ?? s.field,
          direction: s.desc ? 'DESC' : 'ASC',
        }));
        const next = typeof action === 'function' ? action(previous) : action;
        return {
          ...current,
          sort: next.map((s) => ({
            field: props.data.fields.find((f) => (f.state?.displayName ?? f.name) === s.columnKey)?.name ?? s.columnKey,
            displayName: s.columnKey,
            fieldLabels: props.data.fields.find((f) => (f.state?.displayName ?? f.name) === s.columnKey)?.labels,
            desc: s.direction === 'DESC',
          })),
        };
      }),
    [update, props.data.fields]
  );
  const value = useMemo(
    () => ({ filter, setFilter, sortColumns, setSortColumns, timeZone: props.timeZone }),
    [filter, setFilter, sortColumns, setSortColumns, props.timeZone]
  );
  return (
    <TableViewContext.Provider value={value}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {Object.keys(filter).length > 0 && (
          <div style={{ flex: '0 0 auto', padding: '4px 8px' }}>
            <Button
              size="sm"
              variant="secondary"
              fill="text"
              icon="filter"
              onClick={() => setFilter({})}
              data-testid={selectors.components.Panels.Visualization.TableNG.Filters.clearAll}
            >
              {t('grafana-ui.table.view.clear', 'Clear filters ({{total}})', { total: Object.keys(filter).length })}
            </Button>
          </div>
        )}
        <div style={{ flex: '1 1 auto', minHeight: 0 }}>
          <ErrorBoundary dependencies={[options, props.data]}>
            {({ error }) =>
              error ? (
                <div role="alert">
                  {t('grafana-ui.table.view.error', 'Unable to apply this table view.')}
                  <Button onClick={() => update((current) => ({ ...current, filters: {}, sort: [] }))}>
                    {t('grafana-ui.table.view.reset', 'Reset view')}
                  </Button>
                </div>
              ) : (
                children
              )
            }
          </ErrorBoundary>
        </div>
      </div>
    </TableViewContext.Provider>
  );
}

export function transformTableRows(
  rows: TableRow[],
  fields: Field[],
  filters: Record<string, TableViewFilter>,
  sort: SortColumn[],
  parentIndex?: number
): TableRow[] {
  if (!Object.keys(filters).length && !sort.length) {
    return rows;
  }
  const parents = rows.filter((row) => row.__depth === 0);
  const frame: DataFrame = {
    length: parents.length,
    fields: fields.map((field) => ({
      ...field,
      values: parents.map((row) => field.values[row.__index]),
      ...(field.nanos ? { nanos: parents.map((row) => field.nanos![row.__index]) } : {}),
    })),
  };
  cacheFieldDisplayNames([frame]);
  const indices = tableViewIndices(
    frame,
    filters,
    sort.map((s) => ({ field: s.columnKey, desc: s.direction === 'DESC' })),
    parentIndex
  );
  const children = new Map(rows.filter((row) => row.__depth !== 0).map((row) => [row.__index, row]));
  return indices.flatMap((index) => {
    const row = parents[index];
    const child = children.get(row.__index);
    return child ? [row, child] : [row];
  });
}

export function transformTableFilters(
  rows: TableRow[],
  fields: Field[],
  filter: FilterType,
  parentIndex?: number
): ApplyFilterResult {
  const filters = encodeTableFilters(filter);
  const crossFilterOrder = Object.keys(filter).filter((key) => filter[key].parentIndex === parentIndex);
  const crossFilterRows = Object.fromEntries(
    crossFilterOrder.map((key) => [
      key,
      transformTableRows(
        rows,
        fields,
        Object.fromEntries(Object.entries(filters).filter(([id]) => id !== key)),
        [],
        parentIndex
      ),
    ])
  );
  const filteredRows = transformTableRows(rows, fields, filters, [], parentIndex);
  return { filteredRows, crossFilterOrder, crossFilterRows, crossFilterTailRows: filteredRows };
}
