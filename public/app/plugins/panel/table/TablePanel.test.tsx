import { OpenFeatureProvider } from '@openfeature/react-sdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  applyFieldOverrides,
  createTheme,
  FieldType,
  getDefaultTimeRange,
  LoadingState,
  toDataFrame,
} from '@grafana/data';
import { FlagKeys } from '@grafana/runtime/internal';
import { TableCellHeight, type TableOptions } from '@grafana/schema';
import { mockClientSize } from '@grafana/test-utils';
import { getTestFeatureFlagClient, setTestFlags } from '@grafana/test-utils/unstable';

import { getPanelProps } from '../test-utils';

import { TablePanel } from './TablePanel';

const options: TableOptions = { showHeader: true, cellHeight: TableCellHeight.Sm, frameIndex: 0, sortBy: [] };
const fieldConfig = { defaults: {}, overrides: [] };
function setup(empty = false) {
  const series = empty
    ? []
    : applyFieldOverrides({
        data: [toDataFrame({ fields: [{ name: 'Value', type: FieldType.number, values: [3, 1, 2] }] })],
        fieldConfig,
        theme: createTheme(),
        timeZone: 'utc',
        replaceVariables: (s) => s,
      });
  const props = getPanelProps(options, {
    fieldConfig,
    data: { series, state: LoadingState.Done, timeRange: getDefaultTimeRange() },
  });
  render(
    <OpenFeatureProvider client={getTestFeatureFlagClient()}>
      <TablePanel {...props} />
    </OpenFeatureProvider>
  );
  return props;
}

beforeAll(() => mockClientSize({ width: 800, height: 600 }));
afterEach(() => setTestFlags({}));

it('renders empty query results with refreshed features enabled', () => {
  setTestFlags({ [FlagKeys.TableRefresh]: true, [FlagKeys.TableRefreshNewFeatures]: true });
  setup(true);
  expect(screen.getByText('Unable to render data: .')).toBeInTheDocument();
});

it('keeps header sorting viewer-only in the transformation prototype', async () => {
  setTestFlags({ [FlagKeys.TableRefresh]: true, [FlagKeys.TableRefreshNewFeatures]: true });
  const props = setup();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Value' }));
  expect(screen.getAllByRole('gridcell').map((cell) => cell.textContent)).toEqual(['1', '2', '3']);
  expect(props.onOptionsChange).not.toHaveBeenCalled();
});

it('retains saved-sort callbacks with experimental features disabled', async () => {
  const props = setup();
  await userEvent.setup().click(screen.getByRole('columnheader', { name: 'Value' }));
  expect(props.onOptionsChange).toHaveBeenCalledWith({ ...options, sortBy: [{ displayName: 'Value', desc: false }] });
});
