# BH AA rollback/cache call graph

This document is source-driven for the AA rollback/cache crash class. It intentionally does not claim restart or network impact by itself.

## Search terms covered

The repo was searched excluding `node_modules` for: `ROLLBACK TO SAVEPOINT`, `SAVEPOINT`, `bounce`, `handleAATriggers`, `resetMemory`, `readUnitProps`, `saveJoint`, `saveUnit`, `response_unit`, `secondary`, `aa_response`, `assocStableUnits`, `assocUnstableUnits`, `assocUnstableMessages`, `initial_balances`, `rollback`, `cache`, `forget`, `storage`, `mutex`, `joint`, `unit props`.

## Exact call graph: `aa_triggers` to stale unit-props crash

1. Stable MC processing queues AA triggers.
   - `main_chain.js` local `handleAATriggers()` selects distinct `(address, definition, unit, level)` rows from units/outputs/aa_addresses for a stable MCI and inserts them into `aa_triggers` (`main_chain.js:1602-1625`).
   - The queue key is `(mci, unit, address)` in the schema (`sqlite_migrations.js:306-313`).

2. Writer starts AA handling after stabilized triggers.
   - `writer.saveJoint()` calls `aa_composer.handleAATriggers()` when a write stabilized AA triggers and is not inside a larger transaction or under a write lock (`writer.js:711-715`).
   - Startup also calls `aa_composer.handleAATriggers()` to process leftovers (`network.js:4227-4231`).

3. AA queue processing serializes on the AA trigger mutex.
   - `aa_composer.handleAATriggers()` locks `['aa_triggers']`, selects rows joined with `aa_addresses`, orders by mci/level/unit/address, and calls `handlePrimaryAATrigger()` for each row (`aa_composer.js:55-84`).

4. Primary trigger starts a DB transaction and kvstore batch.
   - `handlePrimaryAATrigger()` calls `BEGIN`, creates `kvstore.batch()`, reads the MC unit and trigger unit, constructs a trigger with `getTrigger()`, then calls `handleTrigger()` (`aa_composer.js:87-98`).
   - After `handleTrigger()` returns, it deletes the row from `aa_triggers`, updates `units.count_aa_responses`, writes the kvstore batch, commits SQL, emits responses, and releases the connection (`aa_composer.js:97-139`).

5. `handleTrigger()` validates AA definition and prepares execution state.
   - It normalizes opts, requires `arrDefinition[0] === 'autonomous agent'`, handles parameterized AAs, initializes `objValidationState`, and tracks `arrPreviousAAResponses` (`aa_composer.js:383-445`).

6. Initial AA balance update and rollback savepoint.
   - `updateInitialAABalances()` reads/updates/inserts `aa_balances`, populates `objValidationState.assocBalances`, reads `aa_addresses.storage_size`, and adds `SAVEPOINT initial_balances` for primary executions (`aa_composer.js:458-518`).

7. Primary response unit is generated and saved before secondary trigger completion.
   - `sendUnit()` completes payment payloads, selects inputs, computes unit hash, runs state update formula, validates/saves the response unit, updates final AA balances, records a response, updates storage size, and then calls `handleSecondaryTriggers()` if outputs include non-self addresses (`aa_composer.js:982-1314`).
   - `validateAndSaveUnit()` wraps the unit as `{ unit: objUnit, aa: true, aa_mci: mci }`, calls `validation.validate()`, marks `bUnderWriteLock = true`, sets `conn` and `batch`, and calls `writer.saveJoint()` (`aa_composer.js:1685-1718`).

8. Writer mutates SQL and memory/cache while inside the outer AA transaction.
   - `writer.saveJoint()` detects `bInLargerTx` when passed `objValidationState.conn` and `objValidationState.batch`; in this mode `commit_fn` is a no-op and the outer caller owns SQL/kvstore commit (`writer.js:23-40`).
   - Writer inserts `joints`, `units`, `unit_authors`, messages, inputs, outputs, and app-specific tables (`writer.js:76-82`, `writer.js:168-270`, `writer.js:330-405`).
   - Writer mutates in-memory caches, including `storage.assocUnstableUnits` / `assocStableUnits` path and `storage.assocBestChildren` (`writer.js:586-594`).
   - Writer also pushes `data_feed`, `definition`, `system_vote`, and `system_vote_count` messages into `storage.assocUnstableMessages` before inline payment queries and later ops (`writer.js:595-603`).
   - If the unit contains AA `definition` messages, writer calls `storage.insertAADefinitions()` while still in the larger transaction (`writer.js:611-620`).
   - Writer stores the joint in the provided kvstore batch as `j\n<unit>` and does not write the batch itself when `bInLargerTx` is true (`writer.js:676-681`).

9. Secondary trigger selection and recursive execution.
   - `handleSecondaryTriggers()` selects AA addresses among response output addresses with `ORDER BY address`, creates child triggers, sets `bSecondary = true`, and recursively calls `handleTrigger()` (`aa_composer.js:1589-1627`).
   - If any secondary bounces, a primary execution calls `revert({ message, callChain })` (`aa_composer.js:1628-1635`).

10. Rollback path.
   - `revert()` logs, calls `revertResponsesInCaches(arrResponses)`, copies logs, clears `arrResponses`, clears `stateVars`, clears the kvstore batch, runs `ROLLBACK TO SAVEPOINT initial_balances`, and then calls `bounce(err)` (`aa_composer.js:1644-1668`).
   - `revertResponsesInCaches()` collects `response_unit` values in `arrResponses`, takes the first unit's parent units from `storage.assocUnstableUnits`, calls `storage.forgetUnit()` on each response unit, and then calls `storage.fixIsFreeAfterForgettingUnit(parent_units)` (`aa_composer.js:1779-1795`).
   - `storage.forgetUnit()` deletes cached authors/witnesses, `assocUnstableUnits[unit]`, `assocStableUnits[unit]` if allowed, `assocUnstableMessages[unit]`, and `assocBestChildren[unit]` (`storage.js:2158-2165`).

11. Final bounce save and crash site.
   - After rollback-to-savepoint, `bounce()` builds a bounce payment and calls `sendUnit(messages)` (`aa_composer.js:887-920`).
   - `sendUnit()` calls `storage.readUnitProps(conn, objMcUnit.last_ball_unit)` before completing the bounce unit (`aa_composer.js:982-992`).
   - `storage.readUnitProps()` can compare DB rows against in-memory stable/unstable cache entries and throw on mismatched unit props. It returns cached stable props if available, otherwise reads SQL (`storage.js:1476-1499`), throws `different props` for stable-cache mismatches (`storage.js:1505-1513`), and throws `different props of <unit>, mem..., db...` for unstable-cache mismatches (`storage.js:1519-1529`). The observed primitive crashes when memory has stale unit props for a unit whose DB props have been recalculated/rolled back differently.

## DB transaction boundaries

- Outer AA trigger processing starts with `BEGIN` in `handlePrimaryAATrigger()` (`aa_composer.js:87-90`).
- Primary execution creates `SAVEPOINT initial_balances` after initial AA balance credit (`aa_composer.js:505-507`).
- `writer.saveJoint()` is called inside the same SQL transaction with `bInLargerTx = true`; it does not commit (`writer.js:23-40`, `writer.js:690-705`).
- Secondary bounce rollback is `ROLLBACK TO SAVEPOINT initial_balances` (`aa_composer.js:1663-1668`).
- Final successful outer path writes kvstore batch and commits SQL (`aa_composer.js:106-112`).

## Cache mutation boundaries

- Writer mutates unit caches (`assocUnstableUnits`, `assocStableUnits`, `assocBestChildren`) while saving the response (`writer.js:586-594`).
- Writer mutates `assocUnstableMessages` for `data_feed`, `definition`, `system_vote`, and `system_vote_count` before subsequent ops (`writer.js:595-603`).
- Writer can call `storage.insertAADefinitions()` for AA-defined AAs inside the same outer transaction (`writer.js:611-620`).
- AA composer mutates in-memory `arrResponses`, `stateVars`, and `objValidationState.assocBalances` as execution proceeds (`aa_composer.js:433-445`, `aa_composer.js:458-564`, `aa_composer.js:1486-1523`).

## Rollback boundaries

- SQL is rolled back only to `SAVEPOINT initial_balances`, not to the beginning of the transaction (`aa_composer.js:1663-1668`).
- The kvstore batch is cleared (`aa_composer.js:1663-1665`).
- Only units represented in `arrResponses[*].response_unit` are passed to `storage.forgetUnit()` (`aa_composer.js:1779-1795`).
- No full `storage.resetMemory(conn)` is performed in the rollback path.

## Places where DB rollback can leave memory/cache mutated

1. Writer unit-cache changes performed before a later secondary bounce (`writer.js:586-594`).
2. `assocUnstableMessages` entries added for response messages before a later secondary bounce (`writer.js:595-603`).
3. AA definitions inserted by `storage.insertAADefinitions()` can emit events and mutate AA-related state/caches while SQL remains rollbackable (`writer.js:611-620`, `storage.js:902-956`).
4. `arrResponses` is cleared, but only response units previously recorded in `arrResponses` are forgotten (`aa_composer.js:1660`, `aa_composer.js:1779-1795`).
5. `storage.assocBestChildren` relationships around parents are repaired only via `fixIsFreeAfterForgettingUnit(parent_units)` for the first reverted response unit's parents (`aa_composer.js:1788-1794`).
6. System/data-feed/definition message cache entries are removed only if the exact response unit is forgotten (`storage.js:2164`).

## Why `storage.forgetUnit(response_unit)` is likely narrower than the full mutation set

`revertResponsesInCaches()` only iterates over `arrResponses` entries with a `response_unit` (`aa_composer.js:1782-1786`). It does not independently diff all cache mutations caused by `writer.saveJoint()`. Writer can mutate several structures while saving a response: unit props, best-child links, unstable messages, AA definitions, and possibly system/message-derived caches (`writer.js:586-620`). Forgetting a unit deletes several direct per-unit maps (`storage.js:2158-2165`), but it does not prove all derived relationships recalculated by main-chain/writer logic are restored to the exact SQL rollback state. The known stale unit-props mismatch shows at least one cached prop can outlive or diverge from the DB view after `ROLLBACK TO SAVEPOINT initial_balances`.

## Why `storage.resetMemory(conn)` after `ROLLBACK TO SAVEPOINT initial_balances` is a strong mitigation probe

`storage.resetMemory(conn)` clears memory caches and reinitializes them from the supplied DB connection (`storage.js:2455-2477`). Writer already uses `storage.resetMemory(conn)` after errors in non-larger-tx save paths (`writer.js:699-704`). In the AA rollback path, the DB has just been restored to the savepoint but memory has been mutated by response-unit save logic. Calling `storage.resetMemory(conn)` after `ROLLBACK TO SAVEPOINT initial_balances` would test whether the crash is caused by stale in-memory cache state rather than committed SQL state. If the same valid fixture stops crashing after this reset, it strongly supports a cache/rollback root cause and bounds the mitigation to cache reconciliation rather than consensus semantics.
