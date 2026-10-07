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
