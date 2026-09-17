import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lastValueFrom } from 'rxjs';

import {
  applyFieldOverrides,
  createTheme,
  type DataTransformerConfig,
  FieldType,
  toDataFrame,
  transformDataFrame,
} from '@grafana/data';
import {
  tableFrameKey,
  TABLE_VIEW_TRANSFORM,
  resolveTableViewTransform,
  type TableViewOptions,
} from '@grafana/data/internal';
import { mockClientSize } from '@grafana/test-utils';

import { type AdHocTransformationsApi } from '../../PanelChrome/PanelContext';

import { TableNG } from './TableNG';
import { transformTableFilters } from './TableViewContext';
import { compileFrameToRecords } from './utils';

beforeAll(() => mockClientSize({ width: 800, height: 600 }));

function makeFrame(values = [30, 10, 20, 100]) {
  return applyFieldOverrides({
    data: [
      toDataFrame({
        fields: [
          { name: 'Name', type: FieldType.string, values: ['gamma', 'alpha', 'beta', 'outlier'] },
          { name: 'Value', type: FieldType.number, values },
        ],
      }),
    ],
    fieldConfig: { defaults: {}, overrides: [] },
    theme: createTheme(),
    timeZone: 'utc',
    replaceVariables: (s) => s,
  })[0];
}

function displayedNames() {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('gridcell')[0].textContent);
}

it('uses transformations for local filtering and sorting and preserves source indices on refresh', async () => {
  const user = userEvent.setup();
  const onDisplayedRowIndicesChange = jest.fn();
  const props = { width: 800, height: 600, rowTransformationsEnabled: true, onDisplayedRowIndicesChange };
  const { rerender } = render(<TableNG {...props} data={makeFrame()} />);
  await user.click(screen.getByRole('button', { name: 'Filter Value' }));
  await user.type(screen.getByRole('textbox', { name: 'Minimum' }), '15');
  await user.type(screen.getByRole('textbox', { name: 'Maximum' }), '35');
  expect(displayedNames()).toEqual(['gamma', 'alpha', 'beta', 'outlier']);
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  expect(displayedNames()).toEqual(['gamma', 'beta']);
  await user.click(screen.getByRole('columnheader', { name: /Name/ }));
  expect(displayedNames()).toEqual(['beta', 'gamma']);
  expect(onDisplayedRowIndicesChange).toHaveBeenLastCalledWith([2, 0]);
  rerender(<TableNG {...props} data={makeFrame([40, 25, 20, 100])} />);
  await waitFor(() => expect(displayedNames()).toEqual(['alpha', 'beta']));
  expect(onDisplayedRowIndicesChange).toHaveBeenLastCalledWith([1, 2]);
  await user.click(screen.getByRole('button', { name: 'Clear filters (1)' }));
  expect(displayedNames()).toEqual(['alpha', 'beta', 'gamma', 'outlier']);
});

it('writes dashboard sort into the ad-hoc stage while preserving column transformations', async () => {
  const data = makeFrame();
  const frameKey = tableFrameKey([data], 0);
  let configs: DataTransformerConfig[] = [{ id: 'organize', options: { excludeByName: { hidden: true } } }];
  const listeners = new Set<() => void>();
  const api: AdHocTransformationsApi = {
    get: () => configs,
    set: jest.fn((next) => {
      configs = next;
      listeners.forEach((listener) => listener());
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSourceSeries: () => [data],
  };
  render(
    <TableNG data={data} width={800} height={600} rowTransformationsEnabled rowTransformations={{ api, frameKey }} />
  );
  await userEvent.setup().click(screen.getByRole('columnheader', { name: /Name/ }));
  const view = api.get()[0];
  expect(view.id).toBe(TABLE_VIEW_TRANSFORM);
  expect((view.options as TableViewOptions).sort).toEqual([{ field: 'Name', displayName: 'Name', desc: false }]);
  expect(api.get()[1]).toEqual({ id: 'organize', options: { excludeByName: { hidden: true } } });
  expect(displayedNames()).toEqual(['alpha', 'beta', 'gamma', 'outlier']);
});

it('computes each distribution using all other filters, independent of insertion order', () => {
  const frame = makeFrame();
  const rows = compileFrameToRecords(['Name', 'Value'])(frame);
  const result = transformTableFilters(rows, frame.fields, {
    name: { displayName: 'Name', filteredSet: new Set(['alpha', 'beta']) },
    value: { displayName: 'Value', filteredSet: new Set(), range: { min: 15, max: 35, includeMissing: false } },
  });
  expect(result.filteredRows.map((row) => row.__index)).toEqual([2]);
  expect(result.crossFilterRows.name.map((row) => row.__index)).toEqual([0, 2]);
  expect(result.crossFilterRows.value.map((row) => row.__index)).toEqual([1, 2]);
});

it('offers typed filters on child fields and leaves sibling parents intact', async () => {
  const child = (name: string, values: number[]) =>
    toDataFrame({ name, fields: [{ name: 'Value', type: FieldType.number, values }] });
  const data = toDataFrame({
    fields: [
      { name: 'Group', type: FieldType.string, values: ['East', 'West'] },
      {
        name: 'Children',
        type: FieldType.nestedFrames,
        values: [[child('east', [10, 30])], [child('west', [20, 40])]],
      },
    ],
  });
  const [displayed] = applyFieldOverrides({
    data: [data],
    fieldConfig: { defaults: {}, overrides: [] },
    theme: createTheme(),
    timeZone: 'utc',
    replaceVariables: (s) => s,
  });
  render(<TableNG data={displayed} width={800} height={600} rowTransformationsEnabled />);
  const user = userEvent.setup();
  await user.click(screen.getAllByRole('button', { name: /expand/i })[0]);
  await user.click(screen.getByRole('button', { name: 'Filter east' }));
  await user.type(screen.getByRole('textbox', { name: 'Minimum' }), '25');
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  expect(screen.getByRole('gridcell', { name: '30' })).toBeInTheDocument();
  expect(screen.getByRole('gridcell', { name: 'West' })).toBeInTheDocument();
  expect(screen.queryByRole('gridcell', { name: '10' })).not.toBeInTheDocument();
});

it('keeps standalone tables scoped to their supplied data even when it came from a dashboard view', async () => {
  const source = makeFrame();
  const [data] = await lastValueFrom(
    transformDataFrame(
      [
        resolveTableViewTransform({
          id: TABLE_VIEW_TRANSFORM,
          options: {
            frameKey: tableFrameKey([source], 0),
            filters: { value: { displayName: 'Value', range: { min: 25, includeMissing: false } } },
            sort: [],
          },
        }),
      ],
      [source]
    )
  );
  render(<TableNG data={data} width={800} height={600} rowTransformationsEnabled />);
  expect(displayedNames()).toEqual(['gamma', 'outlier']);
});
