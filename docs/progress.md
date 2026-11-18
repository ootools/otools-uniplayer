# SDD ledger — plan: docs/superpowers/plans/2026-11-17-otools-uniplayer.md

Approval granted 2026-11-17; user requested continued implementation. Main/no worktree/no commit/push; no remote publication or pointer updates.

## Completed deliverables

- Task1: view-scoped sidecar registration, exact owner+view generation authorization/output, stale spawn protection, close/orphan cleanup and process tree lifecycle. Host dedicatedsidecar32/32; hostfull-lib527green7ignored.
- Task2: opt-in document instances, source-safe canonical path reuse/new, strictfilegeneration, defaulttabs preservingexplicitPanel, asynccurrent/activity, configrestore/detach/multiple installedapp/tray source+metadata. Targeted75/75, independent key53/53, hostvue-tscgreen; broadrelated625/627 with2provenexisting menu-arrayfailures.
- Task3: actualRustHTTP/FFmpegfMP4HLS/probe/copy/transcode/keyframeseek/subtitles/pause/GC/budgets/EOF/SIGTERM/SIGHUP/forcegroupkill/cancellation. Final independentcargo26/26. Releasecodesignvalid; FFmpeg9.0.2_1localdev27non-systemdylibs.
- Task4: independentVue UI, hostadapter/protocol/HLS, currentready/lazyinactiveplayback, sourcebusinesspolicyports, documentresume and exactinstancepriority, settings/themes/zh-en. Final41/41 frontendtests+vue-tsc/Vitebuildgreen. Tokenonlystdin/header; pathnotURL; licenses/sourceprovenance.
- Task5: scriptspack/verify/serve/build/prepare, package4/4 runtime3/3, actualdevmac.oplgchecked. FormalpackrefusesmissingmacIntel/sixplatformassets. SDKAPI5snapshotwithhashes. NativevisibleindependentWKWebViewdoublecopy/transcode/seek/pause/closePASS; hiddenrepeat50stimeoutrecorded, backgroundstabilitynotverified.

## Review/fix evidence

Fresh plugin and host read-onlyreviews each4actionablefindings. All adopted throughRED→GREEN: HUPworkerleak; latevideo.playpause; externalsubtitleURL; VTTtimeoffset/selectionrestore; orphanviewcleanup; explicitPANELselector; 2nddetacheddocpersist; source-safe trayrestore.

Extra full-regressionfindings fixed: processgroupchildescapedhostforcekill; httproutercancellationorphanworker/slowbodyshutdown; oldGenerationGatepreventednewprocessretry; closingandnewtablostdocresume; FFmpegatomicrenameENOENTfatalearlywindowstop. Atomicpublishingfix2deterministictestsRED→GREEN; 63.5–66windowassertionunchanged; fullsuite3finalgreenrunsincludingcoordinator26/26.

## Rulings

- Independent subprojects delegated while coordinator retained integration/finalreview, file-scoped to avoid conflictingedits.
- Finite64s officialHLSwindow rather than customfMP4parser; resume/seek/changesmaybuffer.
- Dev-only media runtime (`redistributable:false`,`selfContained:false`), no fakebinaryorsixplatformclaim.
- Existing2hostmenu-arraytestfailureskeptandreported; unrelatedfullscreen-screenshotbuttonalreadyinHEADandunmodifiedfiles.
- Nativehiddenparallelplaybacknotclaimedstable: onefailed50srunandlatervisible/nonactivePASS preserved, scheduling/occlusiononlyhypothesis.

Final evidence and exact counts: docs/VERIFICATION.md and docs/verification-native.json. Build/package outputs in dist-pack (gitignored). No commits, pushes, remote repository creation, market publication or parent submodule pointer changes.

## Final review record (2026-11-18)

- Earlier fresh reviews (plugin: 4 findings; host: 4 findings) all fixed via RED→GREEN regressions; additionally fixed during final regression: process-group escape on host force-kill, HTTP-cancellation orphan worker, stale GenerationGate after process replacement, document resume fallback for new tab identity, FFmpeg atomic-rename ENOENT early stop, storage-root symlink rejection in integration config.
- Final fresh reviewer dispatches for the remaining packaging/runtime diff failed repeatedly on infrastructure (quota/concurrency limits), not on findings. Per executing-plans this pass is therefore a coordinator self-review of the critical paths: repo `dist/` contains no test-observer markers; `local_file` enforces absolute/canonical/regular/extension whitelist; `validateRuntimeMetadata` rejects path traversal/symlink escape and requires source archives + licenses for redistributable=true; subtitle contract (`subtitleURL`) and generation/seek handling have covering tests. Stated limitation: author self-review is weaker than a fresh reviewer.
- Final counts re-verified: Plugin Vitest 41/41 + build; package/runtime tests 11/11; media service 27/27 with bundled static FFmpeg; Host full lib 527 passed/7 ignored; Host directed instances 56/56; Host `vue-tsc` clean; 28-file dev `.oplg` pack+verify; `codesign --verify --strict` on service and media tools; `git diff --check` clean on both repos.
- Known unrelated baseline failures preserved: two `Tools.windowActions.test.ts` menu-array assertions (fullscreen-screenshot item present in HEAD menu, missing from HEAD test expectation; neither file modified this round).
