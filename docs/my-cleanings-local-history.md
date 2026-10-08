# Historial local de Mis limpiezas

La publicación por el conector GitHub consolida los cambios de cada repositorio en un commit remoto. El contenido del árbol se verifica contra el árbol local. Estos SHA originales documentan la secuencia local; no se deben asumir existentes en GitHub.

## pin-go-backend

```text
544416792e1cb772dec01890f864c31aa93201da Add isolated cleaner accounts and personal task API
bdb769c8dce9f177b580e6d4a7be5bdce6a416e3 Validate cleaner account lifecycle against isolated SQL database
f29d9be60339e7ce09dfab17da34e528895de156 Revalidate cleaner Staff binding throughout login MFA
86b58564d1e2b1771475c463f770f0eb2a63d30a Enforce cleaner start and completion windows independently of access
06a4146d16609a9a1508cf1622ece7f25cae5a23 Add property checklists with fixed task snapshots and guarded progress
d084c0efbc6f106de7ee018d8815a751cb4f0e58 Track cleaner canary release and mandatory general activation
008c0d6f40b9112d08e6db41953e47ccb3c10140 Add explicit cleaner cancellation and transactional backup acceptance
e88050f4b55a3e18c97ee7f2b1601ba966128505 fix(pin-ai): distinguish cleaning acceptance from work completion
7b5ea23eaa87edefabd9f29e83b7d307f7ccda2f fix(cleaning): persist exhausted backup attention atomically
16a710c31f4bcca880bd38d2af6f9d2883c0d13d fix(cleaning): defer existing reminders until committed end
85a1442a6e9da5dfacb6f5a435ba78d2dd484e3b Revert "fix(cleaning): defer existing reminders until committed end"
70bccaca1267dfce5c40cf88b3da50daa7dc8e32 docs(cleaning): clarify distinct start and completion reminders
e6e214823e268038f1df8e9d427da7dd3f2fac4c docs(cleaning): record contract audit defects and release blockers
dd8d5b97f7bca51fda3806a8a63b19d8a5199d80 fix(cleaning): verify cleaner card before reporting existing NFC ready
720a19ee7c0509f1215d712d07bdbb6ea36e1c60 docs(cleaning): define independent access transfer and remaining authority gaps
db53e797a172a6aebcda7dcc49457722eb473c4a docs(cleaning): preserve two-hour NFC scheduling for primary and backup
d1ec0036f864cb9e1a94de1d10222b71417c3630 fix(cleaning): validate current cleaner NFC ownership in complete-flow audit
763f622f8cb8c9427ac7397caa544994fb41fadb fix(cleaning): revalidate current cleaner card around NFC programming
c9804a67b39ad844fc55a4b9411f0b6c9654f2a9 fix(cleaning): replace withdrawn unused NFC schedule with backup card
3adf3cfe779ad734f1a4bbaff7c03ae39bed2453 docs(cleaning): audit programmed grant withdrawal target and recovery requirements
789a14f61e1e158ec980f7f77c9a5566a8ee39a0 feat(cleaning): record exact NFC programming target before provider commands
8cba79e89153517ad135d86a948ab413853a1946 feat(cleaning): read exact-target provider NFC period evidence
2b9aac1671b8c81ee255f968ac210c000452a93d docs(cleaning): define integrated backup scheduling and deadline-aware recovery
5338c271689abde45d19019c12deade943c85839 Block cleaner cancellation at canonical window start
f6f943d6ad544ff505e1f6d983ee722535563b90 Cancel unused cleaner NFC intent with explicit withdrawal
8eed7996bc64a2f917a4b8a46f21269fe1832a69 Schedule accepted backup alongside cancelled primary active access
a6e840c88495bc11aa64b4b9645cfc6f67ec917d Allow backup scheduling during cancelled primary programming
14d1e4e40563d7d00b9080d9aeda78f25fc49bd1 Serialize cleaner activation receipt with cancellation
c670cda8acff5d2e6dab1a9ca4527ede8af69fc2 Audit obsolete cleaner reminder retries after reassignment
f75767eec26310f43e5ae50b0e161df72d924ca2 Suppress obsolete cleaner reminder SMS retries
7463195957b063dae56d5d4aca1e29b1e4a86555 Revalidate current cleaner scope before initial reminder delivery
614dd3941accc6cfaf900c465648d270266707a2 Propose reducing routine cleaner access SMS
62b5e6a464c67d6ff4310b86696b54713fb3e178 Remove redundant routine cleaner access SMS
61d0b1e833dd41364219e2471169fb6404bef0b4 Record cleaner daily-view correction and pagination gap
79d4c3ff596e8d2d7641d655ad29086b95b4e56c Filter cleaner task views before server pagination
e26a74919feff8e6e4580c99df85291c83978deb Audit weekend availability hours and urgent dispatch gap
27f6524d8f195d8e211c0197e8e4e93b4cb19ebc Reproduce starvation of later cleaner confirmation offers
3ef50f3f2d7f4923d9ee221b6dc21bbb4d7cd9c3 fix: traverse skipped cleaning confirmation batches
45a3554526b68a075ed614e3ee7a0efa82c1f81d feat: record cleaner delay and incomplete work declarations
8b21cda396ab0279acc4b9f4e03dd74aa1460860 feat: configure property cleaning recovery limits
3414cc195746e03e3412d34c22de159666d6b476 feat: assess cleaner reports within host recovery limits
60506db3bb2ab8c84dfe1cdaab2be30d4ff8e5ac feat: validate exact cleaner access extension command target
be0c501e49a37fef8a1722c9f892d579a52a4ec7 feat: execute bounded cleaning issue recovery with explicit backups
5fd255b8b3c78235325185dce33326bdcaebce3a fix: rediscover cleaning recoveries after failed or interrupted scans
34151b26e02ee5dc71a64ad998135d5788661f54 docs: prepare linked cleaning draft PRs for continuity [skip ci]
```

## pin-go-dashboard

```text
1ef5ad3c31334483c6750ad27d7c0458b3eff460 Add cleaner-only My Cleanings dashboard and account setup
b8b283f98b540c9547e9c34d5624b05a53290ae8 Add host checklist editor and cleaner task progress
aa16d52d7f2e62368bb72c4b8f4a90cde516a124 Allow confirmed cleaners to cancel before starting
3f7e1bece50466784367d6f32c181da20df5c4e5 fix(staff): align reminder settings with committed cleaning end
d57fc721dd135b0eaacd573c7d40d065658295b9 Revert "fix(staff): align reminder settings with committed cleaning end"
95375857e833ca8cda117112db6e5b1211824b7f Hide cleaner cancellation when cleaning window begins
147a425200e9a0f82cc679e8f491d9e960402f7c Keep unfinished previous-day cleanings in daily view
f0e576a8764029cefcb0a1ea629010e2c8b3c38f Request separate pages for each cleaner task view
578712a783d4a87f9a7c9009b28386aafbd192fd feat: let cleaners record task delays and incomplete work
00c744c5dd9bf00e0933fd9ba52c08fd5da8d685 feat: edit property cleaning recovery limits
b6592a6fe706bf327aa958162eb2ee1717715047 feat: show read-only cleaning issue assessments
691ddd200201364a371e51b14dc9c3ec9b87a34e feat: show confirmed cleaning recovery outcomes
```
