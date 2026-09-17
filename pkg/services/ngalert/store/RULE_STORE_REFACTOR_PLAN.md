# Plan: extract `RuleStore` and `ProvenanceStore` out of `ngalert/store.DBstore`

> Working document for the in-flight refactor. Delete (or move to the PR description) before the
> final PR is opened. Keep it updated as steps land — it is the rebase contract (see
> [§9 Rebase playbook](#9-rebase-playbook)).

## 1. Goal

Split the god-object `pkg/services/ngalert/store.DBstore` into three independently wired stores:

| Store | Package | Concrete type | Owns |
| --- | --- | --- | --- |
| Rules | `pkg/services/ngalert/store/rules` | `rules.RuleStore` | alert rules, rule versions, rule labels, rule status, namespaces/folders, deltas, query optimisation |
| Provenance | `pkg/services/ngalert/store/provenance` | `provenance.ProvenanceStore` | the `provenance_type` table, provenance + `ManagerProperties` |
| Everything else (unchanged) | `pkg/services/ngalert/store` | `store.DBstore` | Alertmanager config, admin config, instances (proto), images, orgs, transactions |

Hard constraints from the task:

1. Consumer-side interfaces that `DBstore` satisfied implicitly get **copied** into the new
   packages and composed into one common interface per store, each segment carrying a
   `// Source:` comment pointing at where the original declaration lives.
2. `RuleStore` and `ProvenanceStore` are **separately wired** implementations. They are **NOT**
   re-exported through `DBstore` — no embedded field, no forwarding methods, no type alias.
   Every call site must name the store it actually wants.
3. Methods whose only remaining callers are tests are flagged with a consistent, greppable
   comment prefix.
4. Compilation must be green in: `grafana` (OSS), `grafana` with enterprise linked
   (`make enterprise-dev`), and `../grafana-ruler`.

## 2. Current state (as of this plan)

Already done in the working tree (uncommitted):

- Files moved `store/*.go` → `store/rules/*.go` with `package store` → `package rules` and
  receiver `DBstore` → `RuleStore`: `alert_rule.go`, `alert_rule_labels.go`,
  `alert_rule_status.go`, `compat.go`, `deltas.go`, `json.go`, `models.go`, `namespace.go`,
  `range_to_instant.go` (+ their `_test.go` siblings).
  The moves are otherwise byte-identical to `HEAD` except: package clause, receiver rename,
  `RuleChangeEvent` relocated into `rules/models.go`, and `TimeNow` relocated into `rules/utils.go`.
- New `store/rules/provider.go` — `RuleStore` struct + `ProvideRuleStore` (registers itself with
  `folder.Service.RegisterService`).
- New `store/rules/testing.go` — `rules.SetupStoreForTesting`.
- `store/database.go` — `DBstore` lost `FolderService` / `DashboardService`; `ProvideDBStore` no
  longer calls `RegisterService`; `RuleChangeEvent` and `AlertDefinitionMaxTitleLength` removed.
- `store/testing.go` — `store.SetupStoreForTesting` no longer sets `FolderService`.
- `pkg/services/annotations/annotationsimpl/annotations.go` — takes `*rules.RuleStore`.
- `pkg/services/ngalert/ngalert.go` — added `ruleStore *rules.RuleStore` field, `api.API.RuleStore`
  now points at it. **Nothing assigns `ng.ruleStore` yet.**

Not done: the provenance package, the composite interfaces, all remaining call sites, wire,
enterprise, ruler.

### 2.1 The `go.mod` hunks are expected — do not hand-revert them

`go.mod` currently carries:

```
483:  github.com/grafana/grafana-enterprise v0.0.0
734:  replace github.com/grafana/grafana-enterprise => ../grafana-enterprise
```

These are **not** stray edits. `../grafana-enterprise/enterprise-to-oss.sh:92` adds exactly this
require/replace pair (and `build.sh:72` does the same in CI) so the overlaid enterprise wire graph
resolves — `pkg/server/wireexts_enterprise.go` imports
`github.com/grafana/grafana-enterprise/pkg/userprotection` under the `enterprise` build tag.
`remove-enterprise.sh:35-38` drops them again.

So: they are correct **while enterprise is linked**, and must not be **committed**. Remove them by
unlinking (`make enterprise-undev`, or Ctrl-C the `make enterprise-dev` watcher, which runs
`remove-enterprise.sh` on SIGINT) — not with `git checkout go.mod`, which would break the linked
build until you re-link. If you need them gone without unlinking, use the same command enterprise
CI uses:

```bash
go mod edit -droprequire=github.com/grafana/grafana-enterprise -dropreplace=github.com/grafana/grafana-enterprise
```

Enterprise's `pr-go-workspace-check.yml` does precisely that before diffing `go.mod`, so CI will
not flag the pair — but it _will_ flag any genuine `go.mod` / `go.work` drift, which matters if a
step here adds a Go module.

Before pushing, check `git diff go.mod` shows nothing but these two hunks (if enterprise is
linked) or nothing at all (if it is not).

### 2.2 Current compile errors

```
pkg/services/ngalert/store/rules/alert_rule.go:2005  st.GetProvenances undefined (RuleStore)
pkg/services/ngalert/store/rules/alert_rule.go:2083  st.GetProvenances undefined (RuleStore)
pkg/services/ngalert/api/validation/api_ruler_validation.go:59,60,345,346  undefined: store.AlertRuleMaxTitleLength / store.AlertRuleMaxRuleGroupNameLength
pkg/services/ngalert/accesscontrol/rules.go:196      undefined: store.GroupDelta
pkg/services/ngalert/store/folderlabelsyncer/service.go:119  undefined: store.RuleChangeEvent
pkg/services/folder/cleaner/provider.go:12           *store.DBstore does not implement folder.RegistryService (missing CountInFolders)
pkg/services/folder/folderimpl/folder_unifiedstorage_test.go:325   same
pkg/services/libraryelements/libraryelements_test.go:330           same
pkg/services/ngalert/store/rules/alert_rule_test.go:1957           undefined: DBstore
pkg/storage/unified/federated/stats_test.go:53       ruleStore.InsertAlertRules undefined (*store.DBstore)
```

(`scripts/build/release_publisher` "function main is undeclared" and the `xorm.go` `rand.Int64N`
vet note are pre-existing and unrelated.)

## 3. Conventions

### 3.1 Comment prefixes (all greppable)

| Prefix | Meaning |
| --- | --- |
| `// Source: <path>:<line> (<TypeName>)` | On each copied interface segment — where the consumer-side declaration lives. |
| `// TEST-ONLY:` | On a store method / interface member whose only remaining callers are tests, fakes, mocks, or interface declarations with no production caller. |
| `// TODO(rule-store-split):` | Deliberate follow-up left behind by this refactor. |

Verify with `grep -rn "TEST-ONLY:\|TODO(rule-store-split):" pkg/`.

### 3.2 Naming

Keep the names already chosen by the WIP so the tree does not churn again:
`rules.RuleStore`, `rules.ProvideRuleStore`, `provenance.ProvenanceStore`,
`provenance.ProvideProvenanceStore`. Yes, `rules.RuleStore` and `provenance.ProvenanceStore`
stutter; the alternative (`rules.Store`) collides with the composite interface name and forces a
second rename of the already-moved files. Not worth it.

Composite interfaces live in `rules/persist.go` and `provenance/persist.go` and are named
`rules.Store` / `provenance.Store`.

## 4. Composite interfaces (task 1)

### 4.1 `pkg/services/ngalert/store/rules/persist.go`

One file, segment interfaces + one composite. Each segment is a *copy* of the consumer-side
declaration(s) — do not embed the consumer's type (that would invert the dependency and, for
`ngalert/accesscontrol`, create an import cycle; see §7.1).

```go
// Store is the full surface implemented by *RuleStore. It is composed from the consumer-side
// interfaces that *store.DBstore used to satisfy implicitly. Each segment records where the
// original declaration lives so the two can be kept in sync.
type Store interface {
	NamespaceStore
	RuleReader
	RuleWriter
	RuleVersionReader
	SchedulableRuleReader
	NotificationSettingsStore
	StatusWriter
	FolderRegistryStore
	MaintenanceStore
}
```

Segments and the declarations they are copied from:

| Segment | Methods | Sources |
| --- | --- | --- |
| `NamespaceStore` | `GetUserVisibleNamespaces`, `GetNamespaceByUID`, `GetNamespaceByTitle`, `GetOrCreateNamespaceByTitle`, `GetNamespaceChildren`, `GetNamespacesByRuleUID` | `pkg/services/ngalert/api/persist.go:13` (`RuleStore`), `pkg/services/ngalert/rulesync/syncer.go:50` (`namespaceStore`), `pkg/services/ngalert/state/historian/annotation.go:57` (`RuleStore`), `pkg/services/ngalert/api/prometheus/api_prometheus.go:44` (`RuleStoreReader`), `pkg/services/ngalert/accesscontrol/silences.go:82` (`RuleUIDToNamespaceStore`), `pkg/extensions/remoteruler/proxy.go:40` (`NamespaceStore`) |
| `RuleReader` | `GetAlertRuleByUID`, `GetRuleByID`, `GetAlertRulesGroupByRuleUID`, `ListAlertRules`, `ListAlertRulesByGroup`, `ListAlertRulesPaginated`, `ListDeletedRules`, `GetRuleGroupInterval`, `Count` | `pkg/services/ngalert/api/persist.go:13`, `pkg/services/ngalert/provisioning/persist.go:50` (`RuleStore`), `pkg/services/ngalert/notifier/silence_svc.go:57` (`RuleStore`), `pkg/services/annotations/annotationsimpl/loki/historian_store.go:43` (`RuleStore`), `pkg/services/ngalert/api/prometheus/api_prometheus.go:284,288` (`ListAlertRulesStore`, `ListAlertRulesStoreV2`), `pkg/services/ngalert/limits.go:11` (`RuleUsageReader`) |
| `RuleWriter` | `InsertAlertRules`, `UpdateAlertRules`, `DeleteAlertRulesByUID`, `DeleteRuleFromTrashByGUID`, `IncreaseVersionForAllRulesInNamespaces`, `UpdateFolderFullpathsForFolders` | `pkg/services/ngalert/api/persist.go:13`, `pkg/services/ngalert/provisioning/persist.go:50`, `pkg/services/ngalert/folder_consumer.go:12` (`alertRuleStore`) |
| `RuleVersionReader` | `GetAlertRuleVersions`, `GetAlertRuleVersionFolders` | `pkg/services/ngalert/api/persist.go:13`, `pkg/services/ngalert/provisioning/persist.go:50`, `pkg/services/ngalert/state/historian/annotation.go:57` |
| `SchedulableRuleReader` | `GetAlertRulesKeysForScheduling`, `GetAlertRulesForScheduling` | `pkg/services/ngalert/schedule/schedule.go:44` (`RulesStore`), `pkg/extensions/remoteruler/service.go:46` (`AlertRuleStore`), `pkg/extensions/remoteruler/proxy.go:40` (`NamespaceStore`) |
| `NotificationSettingsStore` | `RenameReceiverInNotificationSettings`, `RenameTimeIntervalInNotificationSettings`, `ListContactPointRoutings` | `pkg/services/ngalert/provisioning/contactpoints.go:42` (`AlertRuleNotificationSettingsStore`), `pkg/services/ngalert/notifier/receiver_svc.go:52` (`alertRuleNotificationSettingsStore`), `pkg/services/ngalert/notifier/autogen_alertmanager.go:20` (`autogenRuleStore`) |
| `StatusWriter` | `SaveAlertRuleStatus` | `pkg/services/ngalert/api/persist.go:41`, `pkg/registry/apps/alerting/rules/alertrule/status.go:25`, `pkg/registry/apps/alerting/rules/recordingrule/status.go:25` |
| `FolderRegistryStore` | `DeleteInFolders`, `CountInFolders`, `Kind`, `GetAllFoldersWithRules` | `pkg/services/folder/registry.go:9` (`folder.RegistryService`), `pkg/services/ngalert/store/folderlabelsyncer/service.go:46` (`syncerStore`) |
| `MaintenanceStore` | `CleanUpDeletedAlertRules` | called from `pkg/services/cleanup/cleanup.go:481`; no consumer-side interface today — declare one here |

Add a compile-time assertion in the same file:

```go
var _ Store = (*RuleStore)(nil)
var _ folder.RegistryService = RuleStore{} // value receiver: RegisterService is called with a value
```

Note the receiver mismatch: every rule method uses a **value** receiver (`func (st RuleStore)`),
`ProvideRuleStore` registers `store` (a value) with the folder service but returns `*RuleStore`.
Both value and pointer satisfy the interfaces; keep it as-is to avoid touching ~50 method
signatures, but assert both.

The consumer-side declarations stay where they are (Go style: interfaces belong to consumers).
`rules.Store` exists so that (a) there is one authoritative list, (b) `var _ Store` catches a
dropped method at compile time instead of at the call site, and (c) enterprise/ruler have a single
name to depend on.

### 4.2 `pkg/services/ngalert/store/provenance/persist.go`

```go
// Store is the full surface implemented by *ProvenanceStore.
type Store interface {
	ProvenanceReader
	ProvenanceWriter
	ManagerPropertiesStore
}
```

| Segment | Methods | Sources |
| --- | --- | --- |
| `ProvenanceReader` | `GetProvenance`, `GetProvenances`, `GetProvenancesByUIDs` | `pkg/services/ngalert/provisioning/persist.go:23` (`ProvisioningStore`), `pkg/services/ngalert/api/prometheus/api_prometheus.go:57` (`ProvenanceStore`), `pkg/services/ngalert/notifier/alertmanager_config.go:546` (`provisioningStore`), `pkg/services/ngalert/notifier/receiver_svc.go:85` (`provisoningStore`), `pkg/services/ngalert/notifier/routes/service.go:21` (`routeProvenanceStore`), `pkg/extensions/remoteruler/proxy.go:45` (`ProvenanceStore`) |
| `ProvenanceWriter` | `SetProvenance`, `DeleteProvenance` | same as above (minus the two read-only ones) |
| `ManagerPropertiesStore` | `GetManagerProperties`, `GetAllManagerProperties`, `SetManagerProperties` | `pkg/services/ngalert/provisioning/persist.go:23`, `pkg/services/ngalert/notifier/alertmanager_config.go:546` |

Assertions: `var _ Store = (*ProvenanceStore)(nil)` and
`var _ provisioning.ProvisioningStore = (*ProvenanceStore)(nil)` — but the latter would make
`provenance` import `ngalert/provisioning`, which imports `notifier/legacy_storage`. **Do not add
it**; put the assertion on the consumer side instead (`pkg/services/ngalert/provisioning/persist.go`
already has `//go:generate mockery`; add `var _ ProvisioningStore = (*provenance.ProvenanceStore)(nil)`
in `pkg/services/ngalert/ngalert.go` or a small `assertions_test.go`).

## 5. The `rules` → `provenance` dependency

`rules/alert_rule.go:2005` and `:2083` (`RenameReceiverInNotificationSettings`,
`RenameTimeIntervalInNotificationSettings`) call `st.GetProvenances` to decide which rules a rename
may touch. Options considered:

- **(chosen)** inject a minimal reader into `RuleStore`:

  ```go
  // ProvenanceReader is the slice of the provenance store that rule writes need in order to
  // honour provisioning ownership when renaming receivers / time intervals.
  // Source: pkg/services/ngalert/store/provenance/persist.go (ProvenanceReader)
  type ProvenanceReader interface {
  	GetProvenances(ctx context.Context, org int64, resourceType string) (map[string]models.Provenance, error)
  }
  ```

  New field `Provenance ProvenanceReader` on `rules.RuleStore`; `ProvideRuleStore` gains a
  `*provenance.ProvenanceStore` parameter. One-directional: `rules` → `provenance`. `provenance`
  must never import `rules`.
- rejected: push the two methods into a third package (splits `alert_rule` cohesion);
- rejected: pass provenance as a per-call argument (changes the
  `AlertRuleNotificationSettingsStore` signature, which enterprise and the app-platform layer use).

`rules.SetupStoreForTesting` must set `Provenance` to the real provenance store over the same
`db.DB` (not a fake) because the existing `alert_rule_test.go` rename tests exercise provenance
filtering end to end.

## 6. Transactions

`store.DBstore.InTransaction` (`store/transactions.go`) stays on `DBstore` and remains
`api.API.TransactionManager` / `provisioning.TransactionManager`. All three stores hold the same
`db.DB`, and `SQLStore.InTransaction` propagates the session through `context.Context`, so a
provisioning flow that writes a rule (`rules`) and its provenance (`provenance`) inside
`DBstore.InTransaction` stays atomic. **This is the single highest-risk property of the refactor** —
cover it with the assertion listed in §8.4.

## 7. Implementation order

Each step should leave the tree compiling (`go build ./...`) so a rebase can stop between steps.

### Step 0 — hygiene
- Revert the two `go.mod` hunks (§2.1).
- `git add -A pkg/services/ngalert/store/rules` so the move is staged and `git log --follow` works.

### Step 1 — `rules` package self-contained
- `rules/persist.go`: segment + composite interfaces (§4.1) and the `var _` assertions.
- `rules/provider.go`: add the `Provenance ProvenanceReader` field + provider parameter (§5), and
  **drop `DashboardService` + `Bus`** from both the struct and `ProvideRuleStore` (§11.3).
- `rules/alert_rule.go:2005,2083`: `st.GetProvenances` → `st.Provenance.GetProvenances`.
- `rules/alert_rule.go`: `// TEST-ONLY:` above `IncreaseVersionForAllRulesInNamespaces` and
  `GetAlertRulesGroupByRuleUID` (§11.4).
- `rules/alert_rule_test.go:1957` and `:4013`: `DBstore` → `RuleStore`.
- `rules/testing.go`: drop `Bus`, wire the real provenance store in.
- Verify: `go build ./pkg/services/ngalert/store/... && go vet ./pkg/services/ngalert/store/...`

### Step 2 — `provenance` package
- `git mv pkg/services/ngalert/store/provisioning_store.go pkg/services/ngalert/store/provenance/provenance.go`
  and the `_test.go` alongside it. `package store` → `package provenance`,
  receiver `DBstore` → `ProvenanceStore`.
  Moves with it: `provenanceRecord`, `managerForProvenanceWrite`, `managerFromRecord`,
  `setProvenanceUpsert`, `provenanceUpsert`, `setProvenanceWithLocking`, `readStoredManager`,
  `setManagerPropertiesUpsert`, `setManagerPropertiesWithLocking`.
- `provenance/provider.go`: `ProvenanceStore{SQLStore db.DB; Logger log.Logger; FeatureToggles featuremgmt.FeatureToggles}`
  + `ProvideProvenanceStore`. Verified: the moved code reads exactly `st.SQLStore`, `st.Logger`
  and `st.FeatureToggles` — no `Cfg`, no `FolderService`, no `AccessControl`, no `Bus`.
- `provenance/persist.go`: §4.2.
- `provenance/testing.go`: `SetupStoreForTesting` mirroring `rules/testing.go`.
- `store/database.go`: **drop `Cfg`, `AccessControl` and `Bus`** from `DBstore`, and narrow
  `ProvideDBStore` to `(featureToggles, sqlstore)` (§11.3). Keep `FeatureToggles` — it is read
  externally at `pkg/services/provisioning/provisioning.go:420`.
- `store/testing.go`: `SetupStoreForTesting` drops the `Cfg` and `Bus` fields it can no longer set.
- Verify: `go build ./pkg/services/ngalert/store/...`

### Step 3 — symbols that moved packages, inside OSS
Mechanical rename of the package qualifier at these sites (the full inventory is §10):

| Symbol | Old | New | Call sites |
| --- | --- | --- | --- |
| `GroupDelta`, `RuleDelta`, `CalculateChanges`, `CalculateRule*`, `UpdateCalculatedRuleFields`, `AlertRuleFieldsToIgnoreInDiff`, `AlertRuleFieldsWhichAffectQuery` | `store.` | `rules.` | `ngalert/accesscontrol/{rules.go,fakes/rules.go}`, `ngalert/api/{api.go,api_ruler.go,testing.go}`, `ngalert/provisioning/{accesscontrol.go,alert_rules.go,testing.go}`, `registry/apps/alerting/rules/alertrule/legacy_storage.go` |
| `AlertRuleMaxTitleLength`, `AlertRuleMaxRuleGroupNameLength`, `ErrOptimisticLock` | `store.` | `rules.` | `ngalert/api/validation/api_ruler_validation.go`, `ngalert/api/api_provisioning.go`, `ngalert/api/api_ruler.go` |
| `RuleChangeEvent` | `store.` | `rules.` | `ngalert/store/folderlabelsyncer/service.go`, **`pkg/extensions/remoteruler/configsyncer.go`** |
| `Optimization`, `OptimizeAlertQueries` | `store.` | `rules.` | `ngalert/api/api_testing.go` |
| `GenerateNewAlertRuleUID` | `store.` | `rules.` | `pkg/tests/api/alerting/api_notification_channel_test.go` |
| `TimeNow` | `store.` | both (see below) | `store/image*.go` keep `store.TimeNow`; rule code uses `rules.TimeNow` |

`TimeNow` is now **two independent vars**. `store/image_test.go` stubs `store.TimeNow`;
`rules/alert_rule_test.go` stubs `rules.TimeNow`. Grep for any test that stubs one and asserts on
the other — there is none today, but a rebase could introduce one. Add a
`// TODO(rule-store-split):` note on both declarations pointing at the other.

### Step 4 — re-type production call sites off `DBstore`
- `pkg/services/folder/cleaner/provider.go` — `*store.DBstore` → `*rules.RuleStore`.
- `pkg/services/ngalert/folder_consumer.go` — the `alertRuleStore` param and `*store.DBstore` field
  → `*rules.RuleStore`.
- `pkg/services/ngalert/store/folderlabelsyncer/service.go` — `syncerStore` mixes rule methods
  (`CountInFolders`, `GetAllFoldersWithRules`) with `FetchOrgIds` (still on `DBstore`). Split into
  two fields (`rules rules.FolderRegistryStore`, `orgs store.OrgStore`) and update
  `NewService` + `ngalert.go:679` + `fullsync.go:68` + `service_test.go`.
- `pkg/services/provisioning/provisioning.go` — `alertingStore *alertstore.DBstore` is used as
  RuleStore (`:404`), ProvenanceStore (`:405,:425,:426,:439,:440,:453,:455,:456,:457`),
  NotificationSettings validator source (`:414`), Alertmanager config store (`:422`), and for
  `FeatureToggles` (`:420`). Add `ruleStore *rules.RuleStore` and `provenanceStore *provenance.ProvenanceStore`
  as new `ProvideService` params (`:71`) + struct fields (`:311`), and keep `alertingStore` for the
  Alertmanager-config and feature-toggle uses.
- `pkg/services/ngalert/ngalert.go` — assign `ng.ruleStore` and a new `ng.provenanceStore` from new
  `ProvideService` params, then re-point each of the ~30 `ng.store` arguments. Mapping:

  | Line(s) | Target |
  | --- | --- |
  | `:231` `ng.store.Logger` | also set `ng.ruleStore.Logger`, `ng.provenanceStore.Logger` |
  | `:244` `notifier.NewCrypto` | `ng.store` (Alertmanager) |
  | `:292,:336,:341-344` | inspect individually — mixed Alertmanager / rule / provenance |
  | `:363` image service | `ng.store` |
  | `:382` alerts router | `ng.store` (admin config) |
  | `:416` `RuleStore:` | `ng.ruleStore` |
  | `:433` | inspect |
  | `:448` `ng.store.SQLStore` | `ng.store` |
  | `:502` `legacy_storage.NewAlertmanagerConfigStore` | `ng.store` |
  | `:505` `routes.NewService(configStore, ng.store, ng.store, …)` | 2nd arg → `ng.provenanceStore` (`routeProvenanceStore`), 3rd → inspect |
  | `:508-509,:524-528,:551-555,:598-602,:621-622` | provenance vs Alertmanager — resolve per signature |
  | `:604` `provisioning.NewAlertRuleService(ng.store, ng.store, …, ng.store, …)` | `ng.ruleStore`, `ng.provenanceStore`, …, `ng.store` (TransactionManager) |
  | `:607` `NewNotificationSettingsValidationService(ng.store)` | `ng.ruleStore` |
  | `:633-637` `api.API{…}` | `TransactionManager: ng.store`, `RuleStore: ng.ruleStore`, `AlertingStore: ng.store`, `AdminConfigStore: ng.store`, `ProvenanceStore: ng.provenanceStore` |
  | `:665` `RegisterQuotas` | `ng.ruleStore` (`Count`) |
  | `:679` folder label syncer | `ng.ruleStore` + `ng.store` (see above) |
  | `:713` `FetchOrgIds` | `ng.store` |
  | `:752` `UpdateFolderFullpathsForFolders` | `ng.ruleStore` |

  Do not guess: for each site, read the callee's parameter interface and pick the store that has
  the methods. `rules.Store` / `provenance.Store` assertions will catch mistakes at compile time.
- `pkg/services/ngalert/rulesync/syncer.go` — `namespaceStore` is satisfied by `rules.RuleStore`;
  the `ngalert.go:621-622` args need re-pointing.

### Step 5 — wire
- `pkg/server/wire_core.go:277` and `pkg/server/bootstrap/wire/sets.go:278`: add
  `rules.ProvideRuleStore` and `provenance.ProvideProvenanceStore` next to `ngstore.ProvideDBStore`.
  Add imports (`ngrules`, `ngprovenance` aliases to match the file's `ngstore` style).
- Regenerate: `make gen-go`. This rewrites `pkg/server/bootstrap/wire/wire_gen.go` and
  `pkg/server/enterprise_wire_gen.go` (both have two `ProvideDBStore` call sites each). **Never
  hand-edit the `wire_gen.go` files.**
- `pkg/server/enterprise_wire_gen.go` regenerates only with enterprise linked; run `make gen-go`
  once inside a `make enterprise-dev` session.

### Step 6 — enterprise (`../grafana-enterprise`)
Only three files reference `ngalert/store`:

| File | Change |
| --- | --- |
| `pkg/extensions/remoteruler/service.go:36,169,249,250,285,318` | `store *store.DBstore` param becomes two params: `ruleStore *ngrules.RuleStore` (feeds `store`/`AlertRuleStore`/`NamespaceStore` at `:249,:285`) and `orgStore *store.DBstore` (feeds `orgStore` at `:250` and `newStatusSyncer` at `:318`, both `FetchOrgIds`). Update the `AlertRuleStore` interface comment to `// Source: pkg/services/ngalert/store/rules/persist.go (SchedulableRuleReader)`. |
| `pkg/extensions/remoteruler/configsyncer.go:27,293` | `store.RuleChangeEvent` → `ngrules.RuleChangeEvent`. |
| `pkg/extensions/remoteruler/configsyncer_test.go:28,211,225,229` | same. |
| `pkg/extensions/enterprise_imports.go:426` | blank import `_ ".../ngalert/store"` — add `_ ".../ngalert/store/rules"` and `_ ".../ngalert/store/provenance"`. |

**`RuleChangeEvent` is the one silent-breakage risk in the whole refactor.** `pkg/bus` keys
listeners by `reflect.TypeOf(msg).Elem().Name()` (`pkg/bus/bus.go:44`) — the *bare type name*, not
the import path. If a duplicate `RuleChangeEvent` were left in `package store`, enterprise would
compile against the old type, register under the same `"RuleChangeEvent"` key, and then panic (or
silently mis-dispatch) at publish time. Therefore: the type must exist in exactly one package
(`rules`), and §8.3's grep must come back empty.

Enterprise edits happen in `../grafana-enterprise`; `make enterprise-dev` copies them into
`pkg/extensions/`. Do **not** edit `pkg/extensions/` in the OSS checkout — `start-dev.sh` will
overwrite it (it also copies OSS→enterprise for `pkg/server`, `local/`, `pkg/operators`, so the
wire changes from Step 5 propagate automatically).

#### 6.1 Cross-repo CI: use the same branch name in both repos

CI pairs the two repos **by branch name**, in both directions:

- OSS: `.github/workflows/backend-unit-tests.yml` job `grafana-enterprise` (runs on every
  non-fork PR) → `.github/actions/setup-enterprise` clones grafana-enterprise and
  `git checkout $GITHUB_HEAD_REF`, falling back to `$GITHUB_BASE_REF`, then `main`.
- Enterprise: `.github/actions/setup-grafana-enterprise` clones OSS and checks out
  `head_ref base_ref` in priority order.

So: **create branches with identical names in `grafana` and `grafana-enterprise`.** Then the OSS
PR is compiled and tested against the enterprise changes, and vice versa, with no manual pinning.
If the names differ, both PRs silently test against `main` of the other repo and the breakage only
appears post-merge.

#### 6.2 Merge-window gap

Branch matching covers CI but not the merge itself. The moment the OSS PR lands on `main`, the
matching enterprise branch no longer matches anything, so enterprise `main` builds against OSS
`main` and is broken until the enterprise PR merges. Because constraint 2 forbids a
`DBstore` compatibility shim, there is no way to make that window zero — it has to be made
*short*: get both PRs approved, merge OSS, merge enterprise immediately after. See §11.1 for the
alternative if the team will not accept even a short window.

### Step 7 — ruler (`../grafana-ruler`)

The ruler consumes Grafana through a committed `vendor/` tree pinned to
`github.com/grafana/grafana v1.9.2-0.20260916100748-f58512f20b4d`, so nothing breaks there until it
re-vendors. Its own code does **not** import `ngalert/store` at all. What it does depend on,
transitively:

- `pkg/ruler/api_compat.go:8` → `ngalert/api/validation`, which uses
  `store.AlertRuleMaxTitleLength` / `store.AlertRuleMaxRuleGroupNameLength` (→ `rules.`).
- `pkg/ruler/rulesmanager/grafana.go:24,28` → `ngalert/api/prometheus` (`RuleStoreReader`,
  `ProvenanceStore`, `ListAlertRulesStore*`) and `ngalert/schedule`.
- `pkg/ruler/rulesmanager/caching_rule_store.go:9`, `compat.go:17` → implements
  `schedule.RulesStore`.
- `pkg/ruler/rulesmanager/alertmanager_alert_sender.go:15` → `ngalert/sender`
  (`store.AdminConfigurationStore`, unchanged).

None of those *consumer-side interfaces* change shape in this refactor, so the ruler should need
**no source change** — but that has to be *proven* against the local Grafana tree, not assumed.

#### 7.1 Why the obvious routes do not work here

Both of these were tried and both fail; do not burn time on them again.

1. **`go mod edit -replace github.com/grafana/grafana=../grafana` + `go mod vendor`.**
   Grafana is a multi-module repo and, critically, *a replacement module's own `replace`
   directives are ignored* — only the main module's apply. The ruler already carries ~33 pinned
   replaces for Grafana submodules (`pkg/apimachinery`, `pkg/apiserver`, `pkg/plugins`,
   `pkg/infra/features`, `pkg/storage/unified/resourcepb`, `pkg/util/sqlite`,
   `pkg/storage/unified/resource/kv`, `apps/*`), so each of those would need its own local
   replace too. Worse, `go mod vendor` leaves vendor mode and has to re-resolve the ruler's
   private BSR dependencies:

   ```
   buf.build/gen/go/grafana/grafana-ruler/grpc/go: unrecognized import path:
     reading https://buf.build/gen/go/grafana/grafana-ruler/grpc/go?go-get=1: 401 Unauthorized
   ```

   So this route needs working buf.build credentials on top of everything else.

2. **A combined `go.work` over both repos.** Dead end twice over. Listing the Grafana modules in
   `use (...)` collides with the ruler's pinned replaces:
   `go: conflicting replacements for github.com/grafana/grafana/apps/advisor`. Adding `replace`
   overrides to `go.work` to fix that then trips
   `go: workspace module github.com/grafana/grafana is replaced at all versions in the go.work file`.
   Dropping `use` and keeping only workspace-level replaces *does* resolve Grafana correctly — but
   workspace mode ignores `vendor/`, so you land back on the same buf.build 401.

   Note these four replaces in the ruler's `go.mod` point at Grafana modules that **no longer
   exist** in `main` — `apps/alerting/historian`, `pkg/aggregator`, `pkg/promlib`, `pkg/semconv`.
   Harmless while vendored; they will bite whoever next runs `go mod tidy` in the ruler. Not our
   problem to fix in this PR, but worth a heads-up to the ruler owners.

#### 7.2 The route that works: overlay local Grafana onto the vendor tree

Fully offline, non-destructive, and it type-checks the ruler's real import graph. Package-level
`rsync` (`-f '- */'`) preserves vendor pruning; `--delete` is what removes the files this refactor
moved out of `store/`, which is exactly the breakage we want to surface.

Write it once as `../grafana-ruler/scripts/sync-grafana-vendor.sh` (untracked — do **not** commit
it to the ruler; this code block is the source of truth for it):

```bash
#!/usr/bin/env bash
# Overlay a local grafana/grafana checkout onto grafana-ruler's vendor tree so the ruler can be
# type-checked against un-released Grafana changes without a network re-vendor.
#
# Usage:  ./sync-grafana-vendor.sh [/path/to/grafana] [new/pkg/path ...]
# Restore: git checkout -- vendor && git clean -fd vendor
set -euo pipefail

G="${1:-../grafana}"; shift || true
G="$(cd "$G" && pwd)"
R="$(git rev-parse --show-toplevel)"
V="$R/vendor/github.com/grafana/grafana"
MOD="$R/vendor/modules.txt"

# 1. Packages created by the refactor must be registered in modules.txt first, or
#    `go build -mod=vendor` fails with "inconsistent vendoring".
for newpkg in "$@"; do
  python3 - "$MOD" "github.com/grafana/grafana/$newpkg" <<'PY'
import sys, pathlib
mod, want = pathlib.Path(sys.argv[1]), sys.argv[2] + "\n"
lines = mod.read_text().splitlines(keepends=True)
if want in lines:
    sys.exit(0)
start = next(i for i, l in enumerate(lines)
             if l.startswith("# github.com/grafana/grafana v"))
end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("# "))
body = lines[start + 1:end]
pkgs = [(i, l) for i, l in enumerate(body) if l.startswith("github.com/grafana/grafana/")]
at = next((start + 1 + i for i, l in pkgs if l > want), end)
lines.insert(at, want)
mod.write_text("".join(lines))
print("modules.txt += " + want.strip(), file=sys.stderr)
PY
done

# 2. Overlay every package the ruler vendors from the *main* grafana module.
#    Only that module: pkg/apimachinery, apps/* etc. are separate modules with their own
#    modules.txt sections and their own pins -- leave them alone.
python3 - "$MOD" <<'PY' > /tmp/.gfpkgs
import sys, pathlib
lines = pathlib.Path(sys.argv[1]).read_text().splitlines()
start = next(i for i, l in enumerate(lines) if l.startswith("# github.com/grafana/grafana v"))
end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("# "))
for l in lines[start + 1:end]:
    if l.startswith("github.com/grafana/grafana/"):
        print(l[len("github.com/grafana/grafana/"):])
PY

n=0
while read -r rel; do
  [ -d "$G/$rel" ] || { echo "MISSING in local grafana: $rel" >&2; continue; }
  mkdir -p "$V/$rel"
  rsync -a --delete --exclude='*_test.go' --exclude='testdata/' -f '- */' \
        "$G/$rel/" "$V/$rel/"
  n=$((n+1))
done < /tmp/.gfpkgs
rm -f /tmp/.gfpkgs
echo "overlaid $n packages from $G" >&2
```

Run it:

```bash
cd ../grafana-ruler
git status --short vendor            # MUST be empty before you start
scripts/sync-grafana-vendor.sh ../grafana \
    pkg/services/ngalert/store/rules \
    pkg/services/ngalert/store/provenance
go build -mod=vendor ./...
go test  -mod=vendor ./pkg/ruler/...

# restore -- always, and verify
git checkout -- vendor && git clean -fd vendor
git status --short vendor            # MUST be empty again
```

`--delete` rewrites tracked files under `vendor/`, so treat the restore as mandatory, not
optional. If `git clean -fd` leaves something behind it is an ignored file
(`pkg/services/ngalert/api/tooling/spec-stable.json` is one) — delete it by hand.

#### 7.3 Verified result (run against the WIP tree on 2026-09-17)

Baseline `go build -mod=vendor ./...` in the ruler: **clean**. With the overlay applied (135
packages overlaid), the *only* failures were the two Grafana-side breakages that the ruler's
import graph actually reaches:

```
vendor/.../ngalert/api/validation/api_ruler_validation.go:59,60,345,346  undefined: store.AlertRuleMaxTitleLength / store.AlertRuleMaxRuleGroupNameLength
vendor/.../ngalert/accesscontrol/rules.go:196                            undefined: store.GroupDelta
```

Two conclusions, both load-bearing for this plan:

- The ruler **does** compile `ngalert/api/validation` and `ngalert/accesscontrol`, so the
  `store.` → `rules.` requalification of `AlertRuleMaxTitleLength`,
  `AlertRuleMaxRuleGroupNameLength` and `GroupDelta` (Step 3) is on the ruler's critical path.
  Get those wrong and the ruler breaks at its next vendor bump.
- Nothing else in the ruler's graph is affected — no `RuleChangeEvent`, no `DBstore`, no
  provenance. Confirms "no ruler source change required".

Re-run 7.2 after Step 3 and again at the end; the expected output is a clean build.

#### 7.4 Interpreting a failure

| Failure | Meaning |
| --- | --- |
| `undefined: store.X` inside `vendor/.../ngalert/...` | a Step 3 requalification was missed in Grafana. Fix in Grafana. |
| `inconsistent vendoring ... is marked as explicit but not required` / missing package | a new Grafana package was not passed as a `new/pkg/path` argument to the script. Re-run with it. |
| a ruler-owned file under `pkg/ruler/` fails to compile | **a consumer-side interface was changed when it should only have been copied.** Fix it in Grafana (§4), not in the ruler. |
| `MISSING in local grafana: <rel>` | Grafana deleted a package the ruler still vendors — unrelated to this refactor, but report it. |

### Step 8 — tests
Re-type the test call sites in §10.3. `store.ProvideDBStore(...)` in tests that actually want rules
becomes `rules.ProvideRuleStore(...)`; several tests need both.

### Step 9 — `TEST-ONLY:` flags (task 3)
Confirmed test-only today (declared in an interface, implemented by the fake, but with **no
production caller**):

| Method | Evidence |
| --- | --- |
| `IncreaseVersionForAllRulesInNamespaces` | declared `api/persist.go:37`, faked `tests/fakes/rules.go:616`, zero call sites |
| `GetAlertRulesGroupByRuleUID` | declared `api/persist.go:24` + `provisioning/persist.go:58`, faked `tests/fakes/rules.go:167`, zero call sites |

Near-misses that are **not** test-only (do not flag): `CleanUpDeletedAlertRules`
(`services/cleanup/cleanup.go:481`), `GetRuleByID` (`annotationsimpl/loki/historian_store.go:99`),
`GetAllFoldersWithRules` (`store/folderlabelsyncer/fullsync.go:68`), `GetAlertRuleVersionFolders`
(`state/historian/loki.go:635`), `GetNamespacesByRuleUID` (`ngalert/accesscontrol/silences.go:364`),
`ListAlertRulesByGroup` (`api/prometheus/api_prometheus.go:570`), `ListAlertRulesPaginated` and
`GetRuleGroupInterval` (`provisioning/alert_rules.go:301,487`).

Placement per §11.4: a single `// TEST-ONLY:` line directly above the method in
`rules/alert_rule.go`. Not on the consumer interfaces, not on the fakes.

Re-derive the list at the end of the refactor rather than trusting this table (see §8.5) — the
`ng.store` → `ng.ruleStore` re-pointing changes what counts as a caller.

## 8. Verification

### 8.1 OSS
```bash
cd /Users/moustafab/workspace/grafana/grafana
go build ./...
go vet ./pkg/services/ngalert/... ./pkg/services/provisioning/... ./pkg/services/folder/... \
        ./pkg/registry/apps/alerting/... ./pkg/storage/unified/federated/... ./pkg/server/...
go test ./pkg/services/ngalert/store/... ./pkg/services/ngalert/api/... \
         ./pkg/services/ngalert/provisioning/... ./pkg/services/ngalert/notifier/...
make lint-go
```
`go vet` stops at the first failing package and does not report packages downstream of a broken
one — re-run it until clean, don't assume the first clean-ish output is the whole story.

### 8.2 Enterprise
```bash
cd /Users/moustafab/workspace/grafana/grafana
make enterprise-dev          # backgrounds a watcher; Ctrl-C unlinks
# in another shell:
go build -tags enterprise ./...
go vet  -tags enterprise ./pkg/extensions/remoteruler/...
go test -tags enterprise ./pkg/extensions/remoteruler/...
make gen-go                  # refresh enterprise_wire_gen.go
```

### 8.3 `RuleChangeEvent` uniqueness
```bash
grep -rn --include="*.go" "type RuleChangeEvent struct" . ../grafana-enterprise
# must print exactly one line: pkg/services/ngalert/store/rules/models.go
grep -rn --include="*.go" "store\.RuleChangeEvent" . ../grafana-enterprise
# must print nothing
```

### 8.4 Transaction atomicity
Add (or extend) a test in `pkg/services/ngalert/provisioning` that runs a rule create through
`DBstore.InTransaction`, forces an error after the provenance write, and asserts neither the rule
nor the provenance row survives. This guards §6.

### 8.5 Re-derive `TEST-ONLY:`
```bash
for m in $(grep -ohE "^func \(st \*?RuleStore\) [A-Z][A-Za-z]*" \
            pkg/services/ngalert/store/rules/*.go | awk '{print $4}' | sed 's/(.*//' | sort -u); do
  n=$(grep -rn --include="*.go" "\.$m(" pkg/ apps/ ../grafana-enterprise/pkg 2>/dev/null \
       | grep -v "_test.go" | grep -vi "fake\|mock" | grep -v "/store/rules/" | wc -l)
  [ "$n" -eq 0 ] && echo "TEST-ONLY candidate: $m"
done
```

### 8.6 Ruler
The ruler is **not** covered by any Grafana CI check, and its vendor pin means a break stays
invisible until someone bumps it weeks later. So it is a required gate here, not a nice-to-have.
Run the §7.2 overlay twice: once right after Step 3 (the requalifications), once at the very end.
Expected output both times:

```console
$ go build -mod=vendor ./...    # no output
$ go test  -mod=vendor ./pkg/ruler/...
ok  github.com/grafana/grafana-ruler/pkg/ruler ...
```

Interpret any failure with the table in §7.4, and confirm `git status --short vendor` is empty
afterwards — the overlay mutates tracked files.

## 9. Rebase playbook

`main` moves fast in `pkg/services/ngalert/store`. Expect several rebases.

### 9.1 Make the move machine-readable
Commit in this shape, in this order, so `git rebase` has the best chance of doing the right thing:

1. `refactor(alerting): move rule store files to store/rules` — **pure `git mv` + package clause +
   receiver rename, nothing else**. Stage with `git mv` (not delete+add) so rename detection fires.
2. `refactor(alerting): move provenance store to store/provenance` — same discipline.
3. `feat(alerting): compose rules/provenance store interfaces` — the new `persist.go` files.
4. `refactor(alerting): wire RuleStore and ProvenanceStore separately` — call sites + wire.
5. `chore(alerting): regenerate wire` — `make gen-go` output only.
6. Enterprise commit(s) in `../grafana-enterprise`.

Keeping (1) and (2) mechanical is what makes rebasing tractable: a new method added to
`store/alert_rule.go` on `main` rebases cleanly into `store/rules/alert_rule.go` **only** if git
sees a rename with high similarity. Any logic change mixed into those commits lowers the similarity
score and turns the next rebase into a manual merge.

Set this once per clone:
```bash
git config merge.renameLimit 20000
git config diff.renames copies
git config rerere.enabled true      # replays the same conflict resolutions across rebases
```

### 9.2 Before every rebase — snapshot what upstream touched
```bash
git fetch origin
BASE=$(git merge-base HEAD origin/main)
git diff --stat $BASE origin/main -- pkg/services/ngalert/store pkg/services/ngalert/api \
  pkg/services/ngalert/provisioning pkg/services/ngalert/notifier pkg/services/ngalert/ngalert.go \
  pkg/server pkg/services/provisioning pkg/services/folder > /tmp/upstream-touched.txt
```
Read that file first. It tells you which of the buckets below you are about to hit.

### 9.3 During the rebase — conflict decision table

| Upstream change | What to do |
| --- | --- |
| New/changed method on `DBstore` in a **moved** file (`alert_rule.go`, `namespace.go`, `compat.go`, `deltas.go`, `json.go`, `models.go`, `range_to_instant.go`, `alert_rule_labels.go`, `alert_rule_status.go`, `provisioning_store.go`) | Take upstream's body verbatim into the new path, then re-apply the two mechanical edits: `package store` → `package rules`/`provenance`, and receiver `DBstore` → `RuleStore`/`ProvenanceStore`. Never take "theirs" wholesale — that resurrects `package store`. |
| New/changed method on `DBstore` in a file that **stayed** (`alertmanager.go`, `admin_configuration.go`, `image.go`, `org.go`, `proto_instance_database.go`, `transactions.go`, `database.go`, `testing.go`) | Take upstream as-is. No action. |
| New method added to a **consumer-side interface** (`api/persist.go`, `provisioning/persist.go`, `schedule/schedule.go`, `notifier/*.go`, `api/prometheus/*.go`, …) | Take upstream, then mirror the method into the matching segment in `rules/persist.go` or `provenance/persist.go`. `var _ Store = (*RuleStore)(nil)` will fail loudly if you forget. |
| New **consumer-side interface** that `DBstore` satisfied | Copy it into the right composite as a new segment with a `// Source:` comment (§3.1), and re-point the construction site to `ng.ruleStore` / `ng.provenanceStore`. |
| New `ng.store` argument in `ngalert.go` | Read the callee's parameter type and pick the store that has the methods. When in doubt, `ng.store` still compiles for anything Alertmanager/admin-config/image/org/transaction shaped. |
| New `store.ProvideDBStore(...)` call site (usually a test) | Decide from what it calls: rules → `rules.ProvideRuleStore`, provenance → `provenance.ProvideProvenanceStore`, otherwise leave it. |
| Wire changes (`wire_core.go`, `bootstrap/wire/sets.go`) | Merge the provider lists by hand; they are hand-written. |
| `wire_gen.go` / `enterprise_wire_gen.go` conflicts | **Do not resolve by hand.** `git checkout --theirs` the generated file, finish the rebase, then `make gen-go` (and again inside `make enterprise-dev` for the enterprise one) and amend. |
| Upstream also touched `store/rules/` or `store/provenance/` (i.e. the refactor already landed) | Stop. The refactor is upstream; re-baseline instead of rebasing. |

### 9.4 After every rebase — the fixed checklist
```bash
# 1. no duplicate types left behind by a bad merge
grep -rn --include="*.go" "type RuleChangeEvent struct" pkg/    # exactly 1
grep -rn --include="*.go" "func (st DBstore)" pkg/services/ngalert/store/rules pkg/services/ngalert/store/provenance   # must be empty
grep -rn --include="*.go" "^package store" pkg/services/ngalert/store/rules pkg/services/ngalert/store/provenance      # must be empty

# 2. DBstore must not have grown rule/provenance methods back
grep -rnE "^func \(st \*?DBstore\) (Get|List|Insert|Update|Delete|Count|Rename|Save)(Alert|Namespace|Rule|Provenance|Manager)" \
  pkg/services/ngalert/store/*.go                               # must be empty

# 3. and DBstore must not re-export them (task 2)
grep -rn "RuleStore\|ProvenanceStore" pkg/services/ngalert/store/*.go   # only in comments, if at all

# 4. full verification
go build ./... && go vet ./pkg/services/ngalert/... && make lint-go

# 5. ruler gate -- the §7.2 overlay, NOT a re-vendor
cd ../grafana-ruler && git status --short vendor      # must be empty before
scripts/sync-grafana-vendor.sh ../grafana \
    pkg/services/ngalert/store/rules pkg/services/ngalert/store/provenance
go build -mod=vendor ./...
git checkout -- vendor && git clean -fd vendor        # and empty after
```
Then §8.1 → §8.2 → §8.3 → §8.5 → §8.6.

A rebase can silently re-break the ruler two ways, neither of which shows up in Grafana's CI:
upstream adds a new `store.` reference inside `ngalert/api/validation` or `ngalert/accesscontrol`
(both on the ruler's critical path, §7.3), or upstream pulls a new Grafana package into the ruler's
import graph — which the overlay reports as `inconsistent vendoring` until you pass that package to
the script.

### 9.5 If a rebase goes badly
The moves are reproducible from scratch. `git rebase --abort`, then re-derive the move on top of
fresh `main`:
```bash
git checkout -b rule-store-split origin/main
for f in alert_rule alert_rule_labels alert_rule_status compat deltas json models namespace range_to_instant; do
  git mv pkg/services/ngalert/store/$f.go      pkg/services/ngalert/store/rules/$f.go
  git mv pkg/services/ngalert/store/${f}_test.go pkg/services/ngalert/store/rules/${f}_test.go 2>/dev/null
done
git mv pkg/services/ngalert/store/alert_rule_backfill_test.go pkg/services/ngalert/store/rules/
git mv pkg/services/ngalert/store/provisioning_store.go      pkg/services/ngalert/store/provenance/provenance.go
git mv pkg/services/ngalert/store/provisioning_store_test.go pkg/services/ngalert/store/provenance/provenance_test.go
sed -i '' 's/^package store$/package rules/'      pkg/services/ngalert/store/rules/*.go
sed -i '' 's/(st \*\{0,1\}DBstore)/(st RuleStore)/' pkg/services/ngalert/store/rules/*.go
sed -i '' 's/^package store$/package provenance/'   pkg/services/ngalert/store/provenance/*.go
sed -i '' 's/(st \*\{0,1\}DBstore)/(st ProvenanceStore)/' pkg/services/ngalert/store/provenance/*.go
```
then cherry-pick commits 3–5 from the old branch. That is why commits 1–2 must stay mechanical.

## 10. Reference inventory

Generated from the tree at the time of writing. Line numbers drift; re-run the greps in §8 after
each rebase.

### 10.1 OSS production files importing `ngalert/store` and the symbols they use

| File | Symbols | Verdict |
| --- | --- | --- |
| `pkg/server/wire_core.go` | `DBstore`, `ProvideDBStore` | add rules + provenance providers |
| `pkg/server/bootstrap/wire/sets.go` | `DBstore`, `ProvideDBStore` | add rules + provenance providers |
| `pkg/server/bootstrap/wire/wire_gen.go`, `pkg/server/enterprise_wire_gen.go` | `ProvideDBStore` ×2 each | regenerate only |
| `pkg/services/folder/cleaner/provider.go` | `DBstore` | → `*rules.RuleStore` |
| `pkg/services/provisioning/provisioning.go` | `DBstore` (`:71`, `:311`) | → `DBstore` + `*rules.RuleStore` + `*provenance.ProvenanceStore` |
| `pkg/services/annotations/annotationsimpl/annotations.go` | — | **already converted** |
| `pkg/services/ngalert/ngalert.go` | `DBstore`, `FetchOrgIds`, `Logger`, `ProtoInstanceDBStore`, `SQLStore`, `UpdateFolderFullpathsForFolders` | the big one; see Step 4 |
| `pkg/services/ngalert/folder_consumer.go` | `DBstore`, `DeleteAlertRulesByUID`, `ListAlertRules` | → `*rules.RuleStore` |
| `pkg/services/ngalert/accesscontrol/rules.go` | `GroupDelta` | → `rules.` |
| `pkg/services/ngalert/accesscontrol/fakes/rules.go` | `GroupDelta` | → `rules.` |
| `pkg/services/ngalert/api/api.go` | `AdminConfigurationStore`, `AlertingStore`, `GroupDelta` | `GroupDelta` → `rules.`; `ProvenanceStore` field type stays `provisioning.ProvisioningStore` |
| `pkg/services/ngalert/api/api_ruler.go` | `CalculateChanges`, `GroupDelta`, `RuleDelta`, `UpdateCalculatedRuleFields`, `ErrOptimisticLock` (+ interface method names) | → `rules.` |
| `pkg/services/ngalert/api/api_provisioning.go` | `ErrNoAlertmanagerConfiguration`, `ErrOptimisticLock` | `ErrOptimisticLock` → `rules.` |
| `pkg/services/ngalert/api/api_testing.go` | `Optimization`, `OptimizeAlertQueries` | → `rules.` |
| `pkg/services/ngalert/api/testing.go` | `GroupDelta` | → `rules.` |
| `pkg/services/ngalert/api/validation/api_ruler_validation.go` | `AlertRuleMaxTitleLength`, `AlertRuleMaxRuleGroupNameLength` | → `rules.` |
| `pkg/services/ngalert/api/api_alertmanager.go` | `ErrNoAlertmanagerConfiguration` | unchanged |
| `pkg/services/ngalert/api/api_configuration.go` | admin-config symbols | unchanged |
| `pkg/services/ngalert/image/service.go` | `DBstore`, `ImageStore`, `ImageAdminStore`, … | unchanged |
| `pkg/services/ngalert/notifier/{alertmanager,images,multiorg_alertmanager,validation}.go` | `AlertingStore`, `ImageStore`, `OrgStore`, `GetImage`, … | unchanged |
| `pkg/services/ngalert/provisioning/accesscontrol.go` | `GroupDelta` | → `rules.` |
| `pkg/services/ngalert/provisioning/alert_rules.go` | `CalculateChanges`, `CalculateRule*`, `GroupDelta`, `RuleDelta`, `UpdateCalculatedRuleFields` | → `rules.` |
| `pkg/services/ngalert/provisioning/contactpoints.go` | `ErrNoAlertmanagerConfiguration` | unchanged |
| `pkg/services/ngalert/provisioning/testing.go` | `GroupDelta` | → `rules.` |
| `pkg/services/ngalert/sender/router.go` | `AdminConfigurationStore` | unchanged |
| `pkg/services/ngalert/store/folderlabelsyncer/service.go` | `CountInFolders`, `RuleChangeEvent` | split `syncerStore`; → `rules.` |
| `pkg/registry/apps/alerting/rules/register.go` | via `ng.Api.RuleStore` | no change (interface-typed) |
| `pkg/registry/apps/alerting/rules/{alertrule,recordingrule}/status.go` | comments say "Satisfied by `*store.DBstore`" | update comments → `*rules.RuleStore` |

### 10.2 Enterprise (`../grafana-enterprise`)
`pkg/extensions/remoteruler/service.go`, `configsyncer.go`, `configsyncer_test.go`,
`enterprise_imports.go` — see Step 6. Nothing else in enterprise imports `ngalert/store`.

### 10.3 Test files to re-type

| File | Symbols |
| --- | --- |
| `pkg/services/cloudmigration/cloudmigrationimpl/cloudmigration_test.go:950` | `ProvideDBStore` |
| `pkg/services/libraryelements/libraryelements_test.go:328,330` | `ProvideDBStore` + `RegisterService` |
| `pkg/services/quota/quotaimpl/quota_test.go:558` | `ProvideDBStore` |
| `pkg/services/folder/folderimpl/folder_unifiedstorage_test.go:325` | `DBstore` + `RegisterService` |
| `pkg/services/ngalert/tests/util.go:89` | `ProvideDBStore` → both stores |
| `pkg/storage/unified/federated/stats_test.go:53` | `SetupStoreForTesting` + `InsertAlertRules` → `rules.` |
| `pkg/services/annotations/annotationsimpl/loki/historian_store_test.go` | `SetupStoreForTesting` → `rules.` |
| `pkg/services/ngalert/accesscontrol/rules_test.go` | `GroupDelta`, `RuleDelta` → `rules.` |
| `pkg/services/ngalert/api/api_convert_prometheus_test.go`, `api_ruler_test.go` | `GroupDelta`, `RuleDelta` → `rules.` |
| `pkg/services/ngalert/api/api_ruler_validation_test.go` | `AlertRuleMax*Length` → `rules.` |
| `pkg/services/ngalert/api/api_provisioning_test.go` | `DBstore` (+ Alertmanager symbols) |
| `pkg/services/ngalert/provisioning/{accesscontrol,alert_rules,contactpoints}_test.go` | `GroupDelta`, `DBstore` |
| `pkg/services/ngalert/store/provisioning_store_test.go` | moves to `provenance/` |
| `pkg/services/ngalert/store/folderlabelsyncer/service_test.go` | `RuleChangeEvent` → `rules.` |
| `pkg/registry/apps/alerting/rules/alertrule/legacy_storage_test.go` | `GroupDelta` → `rules.` |
| `pkg/tests/api/alerting/api_notification_channel_test.go` | `GenerateNewAlertRuleUID` → `rules.` |
| `pkg/tests/api/alerting/api_ruler_test.go` | `AlertRuleMaxTitleLength` → `rules.` |
| `pkg/tests/apis/alerting/notifications/{receivers,routingtree,templategroup,timeinterval}/*_test.go` | `ProvideDBStore` |
| `pkg/services/ngalert/store/rules/*_test.go` | `DBstore` at `alert_rule_test.go:1957` |

### 10.4 Consumer-side interfaces `DBstore` currently satisfies

Rules: `api/persist.go:13`, `provisioning/persist.go:50`, `schedule/schedule.go:44`,
`notifier/silence_svc.go:57`, `notifier/autogen_alertmanager.go:20`,
`notifier/receiver_svc.go:52`, `provisioning/contactpoints.go:42`,
`state/historian/annotation.go:57`, `annotations/annotationsimpl/loki/historian_store.go:43`,
`api/prometheus/api_prometheus.go:44,284,288`, `accesscontrol/silences.go:82`,
`rulesync/syncer.go:50`, `folder_consumer.go:12`, `store/folderlabelsyncer/service.go:46`,
`limits.go:11`, `folder/registry.go:9`, `registry/apps/alerting/rules/{alertrule,recordingrule}/status.go:25`,
`extensions/remoteruler/service.go:46`, `extensions/remoteruler/proxy.go:40`.

Provenance: `provisioning/persist.go:23`, `api/prometheus/api_prometheus.go:57`,
`notifier/alertmanager_config.go:546`, `notifier/receiver_svc.go:85`,
`notifier/routes/service.go:21`, `extensions/remoteruler/proxy.go:45`.

Staying on `DBstore`: `store/database.go:22` (`AlertingStore`),
`store/admin_configuration.go:21`, `store/org.go:9`, `store/image.go:18,40`,
`notifier/alertmanager.go:36`, `notifier/legacy_storage/persist.go:12`, `status/syncer.go:31`,
`state/persist.go:16`, `provisioning/persist.go` (`TransactionManager`),
`extensions/remoteruler/service.go:50` (`OrgStore`).

## 11. Decisions

### Resolved (2026-09-17)

#### 11.1 Merge sequencing — no shim, no special handling

**Decided: ship it straight, a human handles the merge.** No `DBstore` compatibility shim
(constraint 2 stands). The only requirement on us is mechanical:

> **Open the OSS PR and the enterprise PR on branches with the _same name_ in `grafana/grafana`
> and `grafana/grafana-enterprise`.**

That is what makes CI compile each against the other (§6.1). The merge-window gap described in
§6.2 is accepted and is not ours to manage.

#### 11.2 Provenance dependency stays on `RuleStore`

**Decided: keep it.** `RuleStore` gets the injected `ProvenanceReader` field exactly as §5
describes. Do not touch `AlertRuleNotificationSettingsStore`.

#### 11.3 Unused dependencies get dropped

**Decided: trim them.** Measured use in the moved rules code:

| Field | Non-test uses in `rules` |
| --- | --- |
| `SQLStore` | 37 |
| `Logger` | 34 |
| `Cfg` | 10 |
| `FolderService` | 7 |
| `FeatureToggles` | 3 |
| `AccessControl` | 1 |
| `DashboardService` | **0** |
| `Bus` | **0** |

`Bus` at 0 is not a measurement error: `RuleChangeEvent` goes out through
`sess.PublishAfterCommit`, never `st.Bus`.

Resulting shape:

```go
// rules.RuleStore  -- drop DashboardService and Bus
type RuleStore struct {
	Cfg            setting.UnifiedAlertingSettings
	FeatureToggles featuremgmt.FeatureToggles
	SQLStore       db.DB
	Logger         log.Logger
	FolderService  folder.Service
	AccessControl  accesscontrol.AccessControl
	Provenance     ProvenanceReader // §5
}

func ProvideRuleStore(cfg *setting.Cfg, featureToggles featuremgmt.FeatureToggles, sqlstore db.DB,
	folderService folder.Service, ac accesscontrol.AccessControl,
	provenance *provenance.ProvenanceStore) (*RuleStore, error)

// store.DBstore -- drop Cfg, AccessControl and Bus
type DBstore struct {
	FeatureToggles featuremgmt.FeatureToggles
	SQLStore       db.DB
	Logger         log.Logger
}

func ProvideDBStore(featureToggles featuremgmt.FeatureToggles, sqlstore db.DB) (*DBstore, error)

// provenance.ProvenanceStore -- only what provisioning_store.go reads
type ProvenanceStore struct {
	FeatureToggles featuremgmt.FeatureToggles
	SQLStore       db.DB
	Logger         log.Logger
}
```

Verified safe: `st.Cfg`, `st.AccessControl` and `st.Bus` have **zero** references in
`pkg/services/ngalert/store/*.go` including tests. Two things must survive the trim:

- **`DBstore.FeatureToggles` stays** even though it has no internal use once provenance moves out —
  `pkg/services/provisioning/provisioning.go:420` reads `ps.alertingStore.FeatureToggles`.
  Cleaning that up means injecting `featuremgmt.FeatureToggles` into `ProvisioningServiceImpl`
  directly; out of scope, leave a `// TODO(rule-store-split):`.
- **`RuleStore.FolderService` stays public** — `pkg/services/ngalert/tests/util.go:134,136` reaches
  through it (`dbstore.FolderService.Create/Get`).

`ProvideDBStore`'s narrower signature breaks its call sites; they are listed in §10.1/§10.3 and
wire regenerates the rest.

#### 11.4 `TEST-ONLY:` comment placement

**Decided: on the implementation only, for now** — a `// TEST-ONLY:` line directly above the method
in `rules/alert_rule.go`. Not on the consumer interfaces, not on the fakes. Flag only, never
delete.

Applies to `IncreaseVersionForAllRulesInNamespaces` and `GetAlertRulesGroupByRuleUID`; re-derive
the full list with §8.5 at the end.

### Decided, noted for the PR description

1. **Should `deltas.go` live in `rules` at all?** `GroupDelta` / `RuleDelta` / `CalculateChanges`
   are pure domain logic with no DB access, and they are the only reason
   `ngalert/accesscontrol`, `ngalert/api`, `ngalert/provisioning` and
   `registry/apps/alerting/rules` have to import a storage package. A follow-up could move them to
   `ngalert/models` (or `ngalert/rulesdelta`). Out of scope here; keeping them in `rules` matches
   the WIP and keeps this PR reviewable. Flag with `// TODO(rule-store-split):`.
2. **Two `TimeNow` vars** (`store.TimeNow` for images, `rules.TimeNow` for rules) — acceptable, but
   worth a follow-up to inject a clock instead.
3. **`rules.RuleStore` value vs pointer receivers** — left as-is (§4.1). A follow-up could
   normalise to pointer receivers.
4. **`provenance` package name** — the file is `provisioning_store.go` and the consumer interface is
   `provisioning.ProvisioningStore`, but the table is `provenance_type` and the methods are all
   `*Provenance*`. Going with `provenance`; say so in the PR description so reviewers aren't
   surprised.
5. **This plan file's fate** — it lives at `pkg/services/ngalert/store/RULE_STORE_REFACTOR_PLAN.md`
   so it survives rebases next to the code it describes. Delete it in the final commit, or move the
   content into the PR description.
