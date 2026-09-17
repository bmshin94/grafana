# TableNG ad-hoc filtering and sorting experiment

Based on PR #132542 at `c07b4768ec836bca7f1c1afd418ef42dfc11b7bc`.
Branch: `codex/table-adhoc-filter-sort`.

## Try it

Enable `table.refresh` and `table.refreshNewFeatures`, then open the development
dashboard **Panel Tests - Table - Ad-hoc filters and sorting**
(`table-adhoc-filter-sort`). The isolated review instance runs at:

http://localhost:3017/d/table-adhoc-filter-sort/panel-tests-table-ad-hoc-filters-and-sorting

- Open **duration → Filter values**. Move either histogram handle or enter raw
  bounds of 50 and 200. The preview shows 60 of 126 rows; Apply commits the view.
- Add a region filter. Reopen duration: its distribution includes every other
  active filter but excludes its own predicate, allowing the range to widen again.
- Sort from a header, including multi-column sorting. Refresh data or hide a
  filtered column: the view remains active. Clear filters restores the rows.
- Open **observed_at → Filter values**. Start `2026-09-17 12:00` and end
  `2026-09-17 12:30`, in the displayed America/New_York timezone, match 31 rows.
- The remaining panels exercise multiple frames, saved transformations, the column
  sidebar, and nested frames. Child predicates apply only to the selected parent.
- Inspect uses the same controls with `table.inspectDataTableNG`. Flamegraph's top
  table requires `flameGraph.tableNg` as well. Their view state is local.

Sorting is viewer-only, seeded from the saved panel sort. Filters and sort changes
are not saved to panel options or the URL. A page reload starts a fresh view.

## Execution and ownership

`tableView` is an internal, serializable ad-hoc configuration. It compiles to the
existing `filterByValue` and `sortBy` operators, with a table value matcher and an
opt-in stable multi-key sort mode. The existing general-purpose sort transformation
retains its single-key behavior. The flag-off TableNG path retains its current
implementation.

| Host                  | State owner                        | Input and row identity                                                                                                                                                                             |
| --------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard Table panel | Panel's ad-hoc transformation API  | Saved panel transformations run first; row operations precede ad-hoc column organization. Original source fields are rebuilt with field overrides so row callbacks and links use original indices. |
| Explore table         | Local TableNG controller per frame | Uses Explore's supplied frame and preserves datasource filtering/link callbacks. Frames sharing a refId receive distinct component keys.                                                           |
| Inspect               | Local TableNG controller           | Uses exactly the preview data supplied by Inspect. Never writes to a surrounding dashboard API or changes the export source.                                                                       |
| Flamegraph top table  | Local TableNG controller           | Filters the derived symbol table. Original row indices preserve symbol/search/sandwich actions and leave profile topology unchanged.                                                               |

A frame key includes query ID, frame name, field schema/labels, and occurrence.
Field labels distinguish fields sharing a raw name. Ambiguous duplicate display
names or field identities have filtering/sorting disabled. Child predicates include
a parent-value identity guard so a replaced parent does not inherit an old filter.

Numeric/time predicates use raw values and inclusive, optional bounds. Missing and
non-finite values have an explicit inclusion control. Categorical predicates retain
formatted-value selection, including mappings. Numeric controls use a linear
histogram, two slider handles, raw-value inputs, preview, Apply, Cancel, and Clear.
Dates use absolute bounds interpreted in the host timezone.

## Validation

Final checks: 940 Jest tests and 24 snapshots passed; three browser scenarios
plus authentication passed. App and grafana-ui typechecks and changed-file lint passed.
The optional benchmark and existing skips are excluded from that Jest pass count.

Targeted coverage includes TableNG, transform operators, dashboard ad-hoc composition,
Inspect isolation, Explore table plumbing, Flamegraph actions after filtering,
flag-off behavior, nested predicates, duplicate query IDs and labelled fields,
refresh, source row indices, mappings, and nanosecond alignment.

Browser tests cover preview versus commit, refresh, hiding a filtered column,
clearing, timezone-aware dates, keyboard slider editing, focus return, and a scoped
axe accessibility scan. Jest's existing duplicate-manual-mock warning remains.
Meticulous cloud validation was unavailable because the CLI was not authenticated.

The empty-result crash, unequal-frame exclusion length, and nanosecond alignment
regressions were each checked by removing the fix, observing a failing test, then
restoring the fix and verifying green.

Run the optional benchmark with:

```sh
TABLE_VIEW_BENCH=1 yarn jest packages/grafana-ui/src/components/Table/TableNG/tableView.bench.test.ts --runInBand --watch=false
```

Local sample, six fields, one categorical filter, two sort keys, median of seven
runs after warm-up; output indices also checked against the existing implementation:

| Rows    | Existing path | Transformation path |
| ------- | ------------: | ------------------: |
| 10,000  |        9.4 ms |             11.9 ms |
| 100,000 |      111.0 ms |            129.7 ms |

These are operator-level measurements, not end-to-end browser timings.

## Follow-up decisions

- The dashboard prototype executes row transforms in the ad-hoc stage and again
  to project original row indices in TableNG. This preserves callbacks and complete
  distributions, but adds allocations and work. A production version should carry
  an explicit row-selection/provenance result from the stage into the renderer.
- Distributions eagerly recompute with all other predicates. Many filters and wide
  frames need profiling, caching, and possibly deferred histogram computation.
- Linear bins make long tails obvious but can compress the main distribution.
  Quantile/log scales, unit-aware input parsing, richer date presets, and relative
  date ranges remain future work. Absolute dates currently have millisecond precision.
- Identical unnamed frames are distinguished by occurrence; datasource-provided
  stable identities would handle indistinguishable frames changing order better.
- Parent identity changes retire child predicates. Stable parent keys could preserve
  them across parent reordering. Nested column management stays deferred as in the base PR.
- URL sharing/persistence and promoting a viewer filter into a saved transformation
  need a separate product/API decision.

The worktree and dependency copy are isolated at
`/private/tmp/grafana-table-adhoc-filter-sort`. The original checkout is untouched.
The review backend uses port 3017; the frontend dev server uses port 3337.
