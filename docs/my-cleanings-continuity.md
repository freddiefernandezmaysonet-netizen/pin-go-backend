# Mis limpiezas — continuidad desde GitHub

Estado al 7 de octubre de 2026: dos PR abiertos como Draft, enlazados; sin merge ni autorización de despliegue de producción.

| Repositorio | PR | Rama | Commit remoto inicial |
| --- | --- | --- | --- |
| Backend | https://github.com/freddiefernandezmaysonet-netizen/pin-go-backend/pull/376 | agent/cleaner-account-access-v1 | 9f45dbf32a803e8dbad3bf636dae648939f20871 |
| Dashboard | https://github.com/freddiefernandezmaysonet-netizen/pin-go-dashboard/pull/198 | agent/cleaner-account-access-v1 | 744637dda6d54f696ae12eb7d420668608d4411c |

La terminal no tiene credenciales de push. Se publicó mediante el conector GitHub autorizado como commits consolidados, conservando el contenido exacto. Los SHA del historial local son distintos de los SHA remotos; consultar `my-cleanings-local-history.md` para la secuencia original. El nuevo checkout debe partir de las ramas remotas, no intentar localizar los SHA locales en GitHub.

Verificación del contenido publicado inicialmente:

- Backend: fuente local 8e22ca000ec86559989d19fa976e0c9f1ae00dbc; árbol exacto 02654a87f17614abf1a391ec62dcaea4f3e9f9d5.
- Dashboard: fuente local 691ddd200201364a371e51b14dc9c3ec9b87a34e; árbol exacto 66ceabb59c1adbad19c378d12322e09c886fec7c.

Este documento y las actualizaciones de estado posteriores modifican únicamente documentación del Backend. Las 150 pruebas reportadas validan la implementación inicial; no equivalen a checks de GitHub ni certificación física.

## Cómo retomar

1. Consultar los dos PR, sus heads y checks actuales.
2. Leer `my-cleanings-review-20261007.md`, las últimas entradas de `my-cleanings-release-tracker.md` y este documento. Las últimas entradas prevalecen sobre notas históricas.
3. Continuar en las ramas aisladas. No reconstruir desde el ZIP anterior ni reimplementar la asignación, NFC o Twilio.
4. Resolver compatibilidad con el main actual y verificar controles vigentes de activación de Pin AI antes de marcar Ready.
5. Completar las certificaciones pendientes: PostgreSQL nativo concurrente, migraciones autorizadas, revisión visual móvil y NFC real principal/respaldo.
6. Mantener ambos PR Draft, sin auto-merge. La autorización recibida cubre publicar estas ramas y abrir PR; no cubre merge ni despliegue de producción.

Los recordatorios, límites de los botones, duración comprometida independiente y reglas de cancelación/acceso están detallados en la revisión. No ampliar el alcance. La extensión automática de un acceso ENDED sigue fuera de lo implementado.

## Integración con main — 7 de octubre de 2026

Se integran Backend main `ba9cd60ea3a1365dd155e3d438043e84dd61e716` y Dashboard main `2a5b1976fcdf5b94377ba0872977c31ca29c7b25` en las ramas Draft. Se conservan los modelos y el ciclo de cobro recientes de Pin AI, sus rutas/configuración y los modelos/recuperaciones de limpieza.

La recuperación automática usa la habilitación comercial canónica de Pin AI por organización/propiedad y exige aceptación vigente, fechada y atribuida al host. No utiliza el canary de reservas como permiso de hardware ni la ventana de conversación del huésped como ventana de trabajo del cleaner. La exención de cargos no desactiva la asistencia. Los comandos de extensión y respaldo vuelven a comprobar esa habilitación dentro de su transacción; la cancelación normal no adquiere ese requisito.

Validación de integración: 17 pruebas de planificación/recuperación/activación, 64 pruebas de Pin AI existente y ventanas/recordatorios, 45 pruebas API/configuración/recibos, 11 SQL de recuperación, 23 SQL de reasignación/ventanas/checklist/vistas y 3 de interacción React: 163 pruebas aprobadas. TypeScript del cleaner, generación Prisma, bundling del worker y build del Dashboard aprobados. SQL sigue siendo PGlite descartable con comandos físicos simulados. La combinación inicial de fixtures SQL requería un Connect account sintético distinto por organización; se ajustó el fixture sin cambiar la restricción única de producción.

El código integrado se conserva en los worktrees `cleaner-backend-integration` y `cleaner-dashboard-integration`. Los directorios `pin-go-backend` y `pin-go-dashboard` conservan los snapshots previos. Para continuar desde otra sesión, usar siempre los heads remotos de los dos PR. Permanece pendiente certificación PostgreSQL nativa, visual móvil y NFC real. No se hace merge a main ni despliegue de producción.
