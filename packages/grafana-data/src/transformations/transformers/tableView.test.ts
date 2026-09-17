import { lastValueFrom, of } from 'rxjs';

import { toDataFrame } from '../../dataframe/processDataFrame';
import { FieldType } from '../../types/dataFrame';
import { MappingType } from '../../types/valueMapping';

import { filterByValueTransformer, FilterByValueMatch, FilterByValueType } from './filterByValue';
import { sortByTransformer } from './sortBy';
import {
  getTableViewSource,
  tableFrameKey,
  tableViewIndices,
  tableViewOperator,
  transformTableFrame,
} from './tableView';

function frame() {
  return toDataFrame({
    refId: 'A',
    fields: [
      { name: 'Name', type: FieldType.string, values: ['item10', 'item2', 'item2', 'other', 'missing'] },
      { name: 'Value', type: FieldType.number, values: [10, 2, 3, -1, null] },
      { name: 'Time', type: FieldType.time, values: [1000, 1000, 1000, 2000, 3000], nanos: [3, 1, 2, 0, 0] },
    ],
  });
}

it('filters numeric bounds and applies all sort keys with original row indices', () => {
  expect(
    tableViewIndices(frame(), { value: { displayName: 'Value', range: { min: 2, max: 10, includeMissing: false } } }, [
      { field: 'Name' },
      { field: 'Value', desc: true },
    ])
  ).toEqual([2, 1, 0]);
});

it.each([
  [{ min: 0, includeMissing: false }, [0, 1, 2]],
  [{ max: 0, includeMissing: false }, [3]],
  [{ min: 20, includeMissing: true }, [4]],
  [{ includeMissing: false }, [0, 1, 2, 3]],
])('handles open bounds and explicit missing inclusion: %j', (range, expected) => {
  expect(tableViewIndices(frame(), { value: { displayName: 'Value', range } }, [])).toEqual(expected);
});

it('keeps nanoseconds aligned after filtering and sorting', () => {
  const output = transformTableFrame(
    frame(),
    { value: { displayName: 'Value', range: { min: 3, includeMissing: false } } },
    [{ field: 'Time' }]
  );
  expect(output.fields[1].values).toEqual([3, 10]);
  expect(output.fields[2].nanos).toEqual([2, 3]);
  expect(frame().fields[2].nanos).toEqual([3, 1, 2, 0, 0]);
});

it('matches formatted value mappings, including a display name override', () => {
  expect(
    tableViewIndices(
      frame(),
      {
        value: {
          displayName: 'Mapped value',
          fieldName: 'Value',
          values: ['small'],
          displayConfig: {
            mappings: [{ type: MappingType.RangeToText, options: { from: 1, to: 3, result: { text: 'small' } } }],
          },
        },
      },
      []
    )
  ).toEqual([1, 2]);
});

it('does not turn missing fields into a filter of every row', () => {
  expect(tableViewIndices(frame(), { gone: { displayName: 'Gone', values: ['x'] } }, [])).toEqual([0, 1, 2, 3, 4]);
});

it('isolates two frames with identical query IDs and preserves source provenance', async () => {
  const frames = [frame(), frame()];
  const output = await lastValueFrom(
    of(frames).pipe(
      tableViewOperator({
        frameKey: tableFrameKey(frames, 1),
        filters: { value: { displayName: 'Value', range: { min: 3, includeMissing: false } } },
        sort: [{ field: 'Value' }],
      })({ interpolate: (s) => s })
    )
  );
  expect(output[0].fields[1].values).toEqual([10, 2, 3, -1, null]);
  expect(output[1].fields[1].values).toEqual([3, 10]);
  expect(getTableViewSource(output[1])).toBe(frames[1]);
  expect(JSON.stringify(output[1])).not.toContain('tableViewSource');
});

it('scopes child filters to their parent and sorts children separately', async () => {
  const parent = toDataFrame({
    fields: [
      { name: 'Parent', type: FieldType.string, values: ['one', 'two'] },
      { name: 'Children', type: FieldType.nestedFrames, values: [[frame()], [frame()]] },
    ],
  });
  const output = await lastValueFrom(
    of([parent]).pipe(
      tableViewOperator({
        frameKey: tableFrameKey([parent], 0),
        filters: { child: { displayName: 'Value', parentIndex: 0, range: { min: 3, includeMissing: false } } },
        sort: [{ field: 'Value' }],
      })({ interpolate: (s) => s })
    )
  );
  expect(output[0].length).toBe(2);
  expect(output[0].fields[1].values[0][0].fields[1].values).toEqual([3, 10]);
  expect(output[0].fields[1].values[1][0].fields[1].values).toEqual([null, -1, 2, 3, 10]);
});

it('keeps existing sort transformation single-key semantics unless explicitly opted in', async () => {
  const result = await lastValueFrom(
    of([frame()]).pipe(
      sortByTransformer.operator(
        { sort: [{ field: 'Name' }, { field: 'Value', desc: true }] },
        { interpolate: (s) => s }
      )
    )
  );
  expect(result[0].fields[1].values.slice(0, 3)).toEqual([10, 2, 3]);
});

it('reports each frame length correctly when excluding rows from unequal frames', async () => {
  const other = toDataFrame({ fields: [{ name: 'Value', type: FieldType.number, values: [0, 2] }] });
  const output = await lastValueFrom(
    of([frame(), other]).pipe(
      filterByValueTransformer.operator(
        {
          filters: [{ fieldName: 'Value', config: { id: 'greater', options: { value: 1 } } }],
          type: FilterByValueType.exclude,
          match: FilterByValueMatch.all,
        },
        { interpolate: (s) => s }
      )
    )
  );
  expect(output.map((f) => f.length)).toEqual([2, 1]);
  expect(output[1].fields[0].values).toEqual([0]);
});

it('addresses labelled fields sharing a raw name without filtering or sorting the wrong series', () => {
  const data = toDataFrame({
    fields: [
      { name: 'Value', type: FieldType.number, labels: { region: 'east' }, values: [1, 2, 3] },
      { name: 'Value', type: FieldType.number, labels: { region: 'west' }, values: [30, 10, 20] },
    ],
  });
  expect(
    tableViewIndices(
      data,
      {
        west: {
          displayName: 'West latency',
          fieldName: 'Value',
          fieldLabels: { region: 'west' },
          range: { min: 15, includeMissing: false },
        },
      },
      [{ field: 'Value', displayName: 'West latency', fieldLabels: { region: 'west' } }]
    )
  ).toEqual([2, 0]);
});
