# Pin AI: OTA con activación comercial por propiedad

## Alcance

Con `PIN_AI_ALL_ORGANIZATIONS_ENABLED=true`, `PIN_AI_PROPERTY_ACTIVATION_ENABLED=true` y los controles OTA existentes activos, las listas piloto dejan de limitar organizaciones y propiedades. Esto no habilita propiedades: cada anfitrión debe activar Pin AI y tener consentimiento Connect vigente. Sin estos controles globales se conserva el piloto existente.

La API valida el tenant/mapeo y la activación antes de encolar. El worker revalida consentimiento, revisión de activación y ventana de reserva antes de generar y después de generar. Los mensajes previos a la última activación/reactivación no se responden. Reservas vinculadas usan la ventana canónica de 24 horas antes del check-in a 24 horas después del checkout. Consultas sin reserva mantienen únicamente información pública de la propiedad, sin cargo ficticio ni herramientas de una reserva inventada.

Se conservan takeover humano, leases, deduplicación, recibos de envío y bloqueo de reenvíos inciertos. Los incidentes OTA usan la misma activación; historial y avisos ya autorizados permanecen disponibles para su anfitrión después de desactivar nuevas respuestas. No se habilitan modificaciones de reservas OTA ni se cambia early/late checkout.

## Cargo existente, sin modificación

El cargo Connect de USD 1 ya incluye Direct Booking, OTA y reservas manuales, independientemente del canal de mensajes. Una reserva canónica tiene un único registro de cargo. No se cobra por mensaje ni por consulta sin reserva. Demos/propiedades de prueba y cancelaciones antes de servicio siguen excluidas. Si Connect no tiene saldo, el cargo queda pendiente; no se cambia por cobro al huésped, tarjeta o factura SaaS.

## Publicación controlada

1. Aprobar los tests/compilación y el contrato integrado PostgreSQL del PR.
2. Fusionar/publicar backend; no hay cambios de esquema ni migraciones nuevas.
3. Alinear API y worker OTA: `PIN_AI_ALL_ORGANIZATIONS_ENABLED`, `PIN_AI_PROPERTY_ACTIVATION_ENABLED`, `PIN_AI_CONNECT_DEBIT_ENABLED`, `PIN_AI_RESERVATION_FEE_RECORDING_ENABLED` en `true`. Conservar credenciales, controles OTA, fecha UTC inicial y listas piloto para rollback. El worker también requiere los controles de incidentes/notificaciones existentes y `APP_URL`.
4. Registrar/verificar un webhook global **message** en Channex, sin eliminar el webhook de Casa Collores. La documentación permite global y property coexistir. Endpoint HTTPS actual, mismo secreto de API, `is_global=true`, `property_id=null`, `send_data=true`, `is_active=true`. No usar event mask `*`.
5. `ops/pin-ai-global-webhook-once.ts` se empaqueta como función de configuración de una sola ejecución, sin cron/HTTP y restart NEVER. Credenciales y DB por referencias Railway; no se imprimen ni se guardan en git. Primero GET completo, luego recibo durable único antes de POST, después GET de verificación. Un intento incierto sólo permite conciliación GET, nunca otro POST. Despliegue de configuración exige aprobación explícita.
6. Comprobar deployment y log de webhook verificado antes de declarar listo el rollout. No activar propiedades ni aceptar términos por terceros.

## Estado de validación

Pruebas locales de gating, límites de ventana, consentimiento, reactivación, takeover/desactivación durante respuesta y cargo idempotente. API/worker compilados. El contrato PostgreSQL integrado está preparado para CI aislado; los proveedores de correo y débito se simulan allí. Esta prueba no declara certificadas respuestas reales OTA ni cobros en producción.

**Pendientes reales:** confirmar activación de Casa Collores; asistencia, incidentes, entrega externa y débito real USD 1; early/late checkout y recuperación. Freddie decidió realizar esas pruebas después. No declararlas completadas.

Referencia oficial para webhook global: https://docs.channex.io/api-v.1-documentation/webhook-collection .

## Exenciones solicitadas 2026-10-07

Casa Collores, PinGo demo property / Pin&Go Demo Property, Serena Studio y Remanso de Paz: exentas de USD 1 por reserva Direct Booking u OTA, sin desactivar asistencia. `Property.pinAIFeeExempt` bloquea registro, inscripción programada, devengo y débito; los lotes excluyen estas propiedades para evitar inanición. Los cargos ya pagados y evidencia de solicitudes inciertas se conservan; no hay reembolso automático ni replay de débitos exentos.

Migración aditiva con valor false por defecto, sin cambios para las demás propiedades. Operación `ops/pin-ai-fee-exempt-properties.ts`: primero audita coincidencias exactas de nombre sin distinguir mayúsculas; exige exactamente una por cada propiedad y aborta si hay ausencias/duplicados. Aplicar con `PIN_AI_APPLY_PROPERTY_FEE_EXEMPTIONS=true` solo tras verificar las cuatro identificaciones. Esta operación únicamente modifica la marca de exención, dentro de una transacción serializable. No habilita Pin AI ni acepta términos. **Pendiente aplicar/verificar en producción antes de declarar estas exenciones activas y antes del rollout global.**
