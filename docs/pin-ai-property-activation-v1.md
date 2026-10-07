# Pin AI V1 — organización y propiedad

## Disponibilidad global — actualización 2026-10-07

La decisión vigente ofrece Pin AI a todas las organizaciones actuales y futuras. `PIN_AI_ALL_ORGANIZATIONS_ENABLED=true` elimina la selección manual de organizaciones para disponibilidad y, junto con `PIN_AI_CONNECT_DEBIT_ENABLED=true`, permite procesar cargos de cualquier organización sin mantener una lista de IDs. Ambos controles siguen apagados por defecto; esta actualización de código no activa producción.

Las organizaciones sin configuración previa (revisión cero) pueden habilitar sus propiedades directamente. La primera activación de propiedad inicializa y audita la revisión de organización en la misma transacción, después de comprobar autoridad, consentimiento y compatibilidad Connect. No se registra aceptación por terceros ni se activan propiedades en masa. Una deshabilitación explícita previa de organización conserva su efecto y requiere revisión del administrador de Pin&Go.

El worker consulta todos los tenants con lotes limitados y conserva elegibilidad por propiedad, aceptación vigente, cuenta fijada, exclusión de Demo/test e idempotencia. Las nuevas organizaciones no necesitan añadirse a una variable de IDs. Los términos vigentes son Connect USD 1 por reserva de cualquier origen. Los párrafos históricos siguientes describen etapas anteriores; no son el estado actual de certificación ni instrucciones de rollout global.

En modo global, una organización con revisión cero no vuelve al piloto anterior: sin aceptación de propiedad, no obtiene asistencia comercial. Sin modo global se conserva la compatibilidad con el piloto. No utilizar el interruptor de adopción como parada total.

Estado al 2026-10-06: implementación local preparada; no desplegada ni activada en producción.

Corrección comercial vigente: USD $1.00 por reserva de cualquier origen con Pin AI activado, descontado desde Connect. El diseño de factura SaaS fue descartado y desconectado del worker/webhook. Leer `pin-ai-connect-reservation-fee-v1.md`: Account Debits todavía no está implementado ni certificado y se requiere nuevo consentimiento. No habilitar el rollout comercial con los gates o términos anteriores.

## Alcance

- Pin&Go (`PLATFORM_ADMIN` activo) habilita la organización en `/admin/pin-ai`.
- Un administrador activo de esa organización habilita cada propiedad desde su configuración.
- Las reservas nuevas heredan la asistencia de la propiedad. Reportar incidentes del portal ya no requiere añadir cada reserva a una lista manual.
- Las revisiones protegen contra sobrescrituras y la auditoría se guarda en la misma transacción que el cambio.
- Deshabilitar bloquea nuevas conversaciones, reportes y confirmaciones del portal. Los casos existentes siguen disponibles para el anfitrión y sus avisos pendientes pueden entregarse según los controles vigentes.
- Las acciones pagadas mantienen sus controles anteriores. No se amplía Channex/OTA ni se modifica la prueba PG64 pausada.
- La ventana temporal y los límites de incidentes después del checkout siguen pendientes del siguiente paso de V1.

## Compatibilidad y puesta en marcha

La migración agrega `pinAIEnabled=false` y `pinAIRevision=0` a Organization y Property. No activa clientes ni cambia sus revisiones existentes.

`PIN_AI_PROPERTY_ACTIVATION_ENABLED` es un interruptor de adopción, desactivado por defecto. Con él desactivado rige el comportamiento previo, incluso si hay configuración guardada. El Dashboard muestra los cambios como pendientes. **No usar este interruptor para detener el servicio**: volver a `false` restaura el piloto anterior. Para detener el chat completo usar el control existente `PIN_AI_GUEST_GATEWAY_ENABLED` y revisar por separado los canales y avisos.

Con adopción activa, las organizaciones con revisión cero mantienen el piloto. Al guardar por primera vez una organización, sus propiedades quedan sometidas a los nuevos permisos: sólo las propiedades habilitadas reciben asistencia. Revisar las propiedades piloto antes de esa transición.

Secuencia de publicación pendiente:

1. Revisar los cambios de ambos repositorios y validar escrituras concurrentes en PostgreSQL nativo aislado.
2. Aplicar la migración antes del backend; desplegar API y worker de reintentos con el cliente Prisma actualizado y adopción desactivada.
3. Publicar Dashboard. Preparar organización y propiedades seleccionadas; comprobar sus revisiones y auditoría.
4. Activar adopción de manera coherente en API y worker. Se requieren además los controles existentes de gateway, runtime shadow, real read, incidentes y host; los avisos requieren `PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED` y su infraestructura/proveedor.
5. Verificar una propiedad seleccionada y una excluida, una reserva nueva, incidente visible para su anfitrión y desactivación. La entrega real de avisos requiere evidencia independiente; el estado «Activado» de configuración no certifica entrega del proveedor.

No hay cambios de variables, migraciones, despliegues, mensajes externos, cobros ni llamadas reales al modelo efectuados durante esta implementación.

## Validación local

- 90 pruebas de backend: gateway, rutas públicas/confirmaciones, incidentes, decisiones de activación y permisos HTTP.
- 3 pruebas de interacción del Dashboard: organización no habilitada, revisiones/estado pendiente y conflicto que exige recarga.
- 1 prueba con Prisma y SQL sobre PostgreSQL WASM (PGlite): reserva nueva, incidente visible y aislado por organización, desactivación, aviso mediante proveedor simulado, atención del caso y rollback ante fallo de auditoría.
- Migración ensayada sobre esquema y filas previas: valores por defecto y restricciones de revisión no negativa correctos.
- TypeScript de los ámbitos modificados, bundle API/worker y build Dashboard correctos.
- ESLint de archivos nuevos correcto. La página de propiedades conserva 40 errores de estilo preexistentes; el cambio no agrega errores. AppShell conserva una advertencia preexistente.

PGlite usa una conexión: esta ejecución no certifica carreras entre conexiones PostgreSQL nativas ni carga de producción. Tampoco certifica entrega externa, pagos, OTA ni el despliegue.

La prueba persistida se ejecuta únicamente contra localhost y la base `pin_ai_activation_test`, con `PIN_AI_ACTIVATION_DB_TEST=true`. No apuntarla a un entorno compartido. La dependencia de validación PGlite quedó fuera del producto.

## Siguiente paso de V1

Una vez publicado y verificado este bloque: alinear la ventana del portal y el seguimiento de incidentes después del checkout. Después: early/late y recuperación, certificación de canales, editor de conocimiento y control de consumo/costos. Este cambio no declara terminada toda la V1.
