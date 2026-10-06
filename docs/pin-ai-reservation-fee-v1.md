# Pin AI: tarifa por reserva

**Mecanismo descartado el 2026-10-06.** El usuario corrigió el cobro: debe descontarse desde Connect por reserva de cualquier origen. La decisión vigente está en `pin-ai-connect-reservation-fee-v1.md`. Este documento conserva únicamente la historia y evidencia de la prueba anterior; no autoriza facturación SaaS ni publicación comercial.

Preparación local al 2026-10-06, sin publicación ni cobros reales.

## Regla aceptada

USD $1.00 al anfitrión por reservación de Direct Booking u OTA con mensajería compatible, una vez por reserva. La obligación se registra desde 24 horas antes del check-in y se suma a la siguiente factura de su suscripción SaaS. No depende de que el huésped abra el chat. No se registran cargos por cancelaciones anteriores a la ventana, reservas manuales, demos, propiedades de prueba ni canales no compatibles. Varias conversaciones no generan cargos adicionales.

## Auditoría de identity check

`public-booking.routes.ts` agrega el cargo de identity check a la comisión de plataforma al crear el checkout. El cálculo de `direct-booking-connect-fee.service.ts` reduce el importe que recibe el host; no aumenta el total del huésped. La reserva conserva el desglose y Dashboard lo muestra en payouts. Este flujo no cobra a los hosts por reservas OTA.

Reutilizar ese descuento inicial para Pin AI adelantaría su cobro al momento de reservar, contrario a la ventana aceptada. La preparación actual conserva el desglose por reserva sin modificar identity check ni los pagos de huéspedes.

## Implementado

- Tarifa fija del servidor y versión `pin-ai-usd-1-reservation-v1`.
- Consentimiento explícito en la propiedad; API rechaza activar sin la versión vigente (428).
- Fecha, administrador y versión de aceptación guardados con la activación y su auditoría; desactivar no exige aceptar nuevamente ni borra la aceptación anterior.
- `PinAIReservationFee`: clave primaria por reserva, 100 centavos USD y evidencia de aceptación, con estado `PENDING_INVOICE`. No significa pagado.
- Servicio local `recordPinAIReservationFee`, desactivado por defecto con `PIN_AI_RESERVATION_FEE_RECORDING_ENABLED`. Valida organización, propiedad, reserva, ventana, consentimiento y runtime. OTA exige además el permiso de auto-respuesta existente.
- Reserva canónica única evita duplicados por conversaciones, reintentos o volver a activar una propiedad. Activar durante una ventana abierta sólo registra cuando se verifica el servicio, sin retroactividad a ventanas ya cerradas.
- Ciclo periódico integrado en `reservation.worker`, independiente del ciclo principal de accesos/limpieza, con lotes limitados, exclusión de ejecuciones simultáneas en el proceso y leases persistidos para reinicios.
- Exportación de una línea a la suscripción canónica del host. Customer/subscription se fijan antes de crear; se verifican importe, moneda y metadata. Descuentos del SaaS no aplican al dólar. Nunca se usa el customer del huésped ni Stripe Connect del host.
- La clave de idempotencia es estable por reserva. Se guarda la identidad de la línea antes de consultar la factura. Ante respuesta incierta sólo se repite dentro de 23h; después pasa a `NEEDS_REVIEW` sin otro create.
- Estados separados: `PENDING_INVOICE`, `INVOICED`, `PAID`, `NEEDS_REVIEW`. Sólo evidencia actual de factura pagada sin saldo permite `PAID`. Una factura fallida abierta no genera una nueva línea; Stripe conserva su ciclo de pago.
- Webhook existente, tras firma y claim de evento, concilia leyendo evidencia actual para evitar errores por eventos desordenados. Ignora eventos Connect. El polling recupera eventos que llegaron antes de guardar la línea.
- Dashboard Billing muestra totales acumulados y hasta 50 cargos recientes por reserva. Permisos actuales y organización se validan; el caché incluye usuario y organización.

## Pendiente para publicación comercial

La integración de registro periódico, adaptador Stripe y conciliación está preparada localmente. Creación, asociación a factura, repetición HTTP con la misma clave y pago con tarjeta se verificaron en sandbox con Stripe SDK 14.25.0/API 2023-10-16 (evidencia abajo). **Faltan PostgreSQL nativo multiconexión, entrega real del webhook hasta el ledger y ejecución completa sobre Node/API/worker con persistencia**. La prueba SDK se ejecutó en Bun y no inyectó una desconexión de red. No habilitar producción antes de completar esas certificaciones.

Para publicar: revisar ambos repositorios; aplicar las cuatro migraciones de activación, consentimiento, ledger y exportación antes de API/worker actualizados; publicar Dashboard. Verificar la asociación existente de Subscription con el customer/subscription SaaS del host. No crear otra suscripción para Pin AI.

La activación requiere `PIN_AI_PROPERTY_ACTIVATION_ENABLED`, `PIN_AI_RESERVATION_FEE_RECORDING_ENABLED`, `PIN_AI_BILLING_ENABLED` y una lista explícita `PIN_AI_BILLING_ORGANIZATION_IDS` (sin `*`), además de controles de runtime. Las organizaciones gestionadas requieren consentimiento y facturación habilitada para nueva asistencia del portal; las no gestionadas conservan el piloto. No ampliar OTA con esos flags: conserva su habilitación separada.

Pausar con `PIN_AI_BILLING_ENABLED=false` detiene nuevos ciclos/exportaciones y nueva asistencia comercial del portal, conservando registros y casos. Revisar OTA por separado. No usar `PIN_AI_PROPERTY_ACTIVATION_ENABLED=false` como kill switch: restaura el piloto anterior.

El ciclo valida estado actual: no reconstruye ventanas omitidas sin evidencia de servicio. Cargos ya registrados no se anulan automáticamente por cancelaciones posteriores o desactivación. Una suscripción no activa pospone exportación y conserva el registro pendiente. `NEEDS_REVIEW` requiere conciliación, sin reenvío ciego.

Stripe limita líneas por factura. Esta V1 exporta una por reserva: verificar volumen de cada organización antes de habilitar y prever agregación para cuentas grandes. Los límites del proveedor no autorizan adelantar cobros, crear facturas adicionales ni marcar como pagado.

## Validación

84 pruebas focalizadas aprobadas: 77 backend (exportación, permisos, gate público, regresión y contratos de webhook), 6 interacciones Dashboard y 1 ciclo persistido con Prisma sobre PostgreSQL WASM. El ciclo persistido verifica ledger único, adaptador Stripe simulado, webhook/pago, tenant, reserva sin chat y suscripción no activa sin create. Migraciones ensayadas con filas existentes. TypeScript de servicios y ámbitos Pin AI, bundles API/worker, ESLint de componentes afectados y build Dashboard correctos. Esto no certifica Stripe real ni PostgreSQL multiconexión.

No se desplegaron cambios ni se operó la cuenta Stripe de producción. Los recursos sintéticos creados en sandbox se detallan abajo.

La verificación estricta del nuevo componente expuso un tipo de cabecera de autenticación previo incompatible con `HeadersInit`. Se añadió únicamente `Record<string, string>` al retorno del helper; no modifica el comportamiento de autenticación. La comprobación estricta pasó después de esa corrección.

## Sandbox Stripe: certificación parcial del 2026-10-06

Cuenta autorizada `acct_1SmdRdRzkK1jKKf3` (Pin&Go sandbox), todos los recursos `livemode=false`. Cliente sintético sin email `cus_VOPFHvBWACf0Or`; precio base mensual cero `price_1UNcRSRzkK1jKKf3AVbPXVZh`; suscripción `sub_1UNcRdRzkK1jKKf3UlDqHIjw`. Se creó una única línea `ii_1UNcRvRzkK1jKKf3YxA0hMFL` de 100 centavos USD, sin descuentos, asociada a esa suscripción y con metadata de reserva/organización/propiedad/términos sintéticos. La factura `in_1UNcSvRzkK1jKKf36UVRXr1J` incluyó exactamente esa línea, total 100, y se finalizó abierta con saldo 100 y fecha de pago nula.

El conector usó API `2026-09-30.preview`: la suscripción aparece en `parent.subscription_details.subscription`, sin campo superior `subscription`; la factura tampoco expone `paid`. Se corrigió únicamente el adaptador Pin AI y su conciliación para leer ambos formatos. Si las dos asociaciones contradicen sus IDs, no se atribuye la factura. El formato moderno requiere estado `paid`, saldo cero y transición `paid_at`; un `paid=false` explícito del formato anterior nunca se sustituye. Referencia: https://docs.stripe.com/api/invoices/object . El SDK Stripe 14 y su versión API actual se conservaron.

La respuesta real abierta, reducida a campos necesarios y sin enlaces privados/card data, está en `src/pin-ai/fixtures/fee-stripe-sandbox-20261006.json`. Cinco pruebas nuevas verifican lectura, rechazo de asociaciones contradictorias, criterios de pago simulados y conciliación/replay local de esa evidencia sin otro create. La prueba del formato pagado es simulada, **no evidencia de un cobro sandbox**. Pasaron 20 pruebas focalizadas de facturación, TypeScript estricto y nuevamente el ciclo persistido con migraciones en PostgreSQL WASM.

El conector no expone la operación de pago de factura ni encabezados de idempotencia; no se certificaron pago, entrega real de webhook ni retry HTTP del SDK. Al terminar se anuló la factura sintética (`void`) y se canceló la suscripción (`canceled`, sin factura final ni prorrateo). Se conservaron cliente/precios/productos de prueba para trazabilidad. No hubo cobro real, correos ni cambios en PG64.

## Prueba SDK preparada, pendiente de credencial del sandbox

`src/scripts/certify-pin-ai-fee-sandbox.ts` usa Stripe instalado en el repositorio y API `2023-10-16`, como `src/billing/stripe.ts`. No importa ese módulo ni carga `.env`: exige exclusivamente `PIN_AI_SANDBOX_STRIPE_SECRET_KEY`, rechaza claves live y comprueba `acct_1SmdRdRzkK1jKKf3` antes de escribir. Preferir una clave restringida de prueba con los permisos necesarios para leer la cuenta y operar clientes, productos/precios, suscripciones, líneas, facturas y cargos sintéticos. No cambiar variables de API/worker de producción.

La prueba crea un cliente sin email y una suscripción base cero; usa el adaptador real para repetir el mismo create con idéntica clave de idempotencia; verifica una sola línea pendiente de 100 centavos sin descuentos; finaliza la factura y paga con tarjeta `tok_visa`. Exige factura pagada, saldo cero y cargo Stripe de prueba por 100 centavos. Conserva recibos pagados; anula facturas abiertas, cancela la suscripción sin prorrateo/factura final y archiva su precio/producto al terminar. Sólo actúa sobre IDs creados en esa ejecución.

Se imprime un identificador de ejecución antes de crear recursos para conciliación manual si la respuesta de un create se pierde realmente. Un resultado incierto no autoriza repetir ciegamente todo el script: revisar la metadata `pin_ai_qa` de esa ejecución. La repetición preparada simula descarte de respuesta en la aplicación; no inyecta una desconexión de red. Tampoco certifica entrega HTTP real del webhook ni la persistencia PostgreSQL. No elevar esos resultados a certificación comercial completa.

Ejecución en PowerShell, desde el backend que contiene este archivo, con dependencias instaladas:

```powershell
$qaSecret = Read-Host 'Clave restringida de Pin&Go sandbox (rk_test_)' -AsSecureString
try {
    $env:PIN_AI_SANDBOX_STRIPE_SECRET_KEY = [System.Net.NetworkCredential]::new('', $qaSecret).Password
    node --import tsx src/scripts/certify-pin-ai-fee-sandbox.ts
    if ($LASTEXITCODE -ne 0) { throw 'Certificación pendiente: revisar recursos sintéticos de la ejecución.' }
} finally {
    Remove-Item Env:PIN_AI_SANDBOX_STRIPE_SECRET_KEY -ErrorAction SilentlyContinue
    $qaSecret = $null
}
```

No enviar claves por chat ni guardarlas en código. En este entorno la variable requerida no está disponible; el flujo externo no se ejecutó. Pasaron 3 pruebas de rechazo de credenciales/cuentas incorrectas y TypeScript estricto del script. Referencias: https://docs.stripe.com/api/invoices/pay y https://docs.stripe.com/api/idempotent_requests .

## Ejecución en certification preparada

Se confirmó que Railway `PinGo Stay-Time Certification` (`84db0f26-4fd1-413b-bcc5-c5b7014f3a9c`), entorno `certification` (`9833f06b-463f-4551-bda7-a9a1eaaa9aa6`), ya tiene `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` en `stay-time-api`; OAuth sólo permite ver los nombres. No se requiere crear ni exponer otra clave. La prueba verifica que esa clave sea test y corresponda al sandbox autorizado antes de escribir.

Se preparó, sin desplegar, la Function `pin-ai-fee-certification-once` (`ab52e2fa-a85c-4457-9cde-a92043a9bf04`), Bun 1.4.0 y Stripe 14.25.0/API 2023-10-16. Su fuente es el bundle del script y adaptador de esta rama, con import versionado Stripe y ejecución de entrada directa. Usa referencia Railway `${{stay-time-api.STRIPE_SECRET_KEY}}` y un UUID de ejecución fijo. No usa base de datos, webhook secret, dominio público ni cron. No modifica `stay-time-api`, PostgreSQL, su rama o despliegue.

El intento de configurar la política de reinicio del servicio pendiente devolvió `Service Instance not found`. Se añadió en su lugar un guard persistido en el cliente sintético: create con idempotencia por UUID, lectura actual de `certificationState` y marcado `ATTEMPTED` antes de crear precio/suscripción/cargo. Una nueva ejecución de ese UUID se detiene para revisión. La fuente temporal expira una hora después de su preparación, antes de que pueda vencer la retención de idempotencia. Los errores se registran sin secretos y la Function termina con código cero para no provocar reintentos por fallo; **salir con cero no demuestra certificación**, sólo un resultado JSON `paid=true` junto con recibo verificado permite declararla. Antes de aprobar, comprobar vigencia y que el patch sólo contiene esta Function; si expiró, renovar sólo la fecha del código pendiente.

Patch preparado `7ac73924-6d02-459a-97a0-b43082ad4a67`: 5 cambios, sólo creación de la Function y sus dos variables, sin cambios destructivos ni despliegue iniciado. Cuatro pruebas del script y TypeScript estricto aprobados, incluida la detención de una ejecución repetida. Railway exige confirmación explícita para `accept-deploy`; pendiente de autorización para desplegar únicamente esta tarea temporal. Tras ejecutarla revisar resultados, ajustar política de reinicio a NEVER cuando exista la instancia y retirar la tarea temporal.

## Resultado SDK en certification: pago aprobado

El usuario autorizó desplegar la tarea y aplicó manualmente el patch porque el control de aprobación del conector canceló `accept-deploy`. No se modificaron `stay-time-api`, PostgreSQL ni las ramas de producción. La tarea temporal se configuró sin cron y con política NEVER cuando ya existía su instancia.

El primer intento produjo una factura de 100 centavos, pero falló sin pagar; el archivado de su precio ocultó la causa inicial. Se añadieron diagnósticos de fase/código/parámetro sin datos secretos y se corrigió el archivado a producto primero y precio después. Un intento controlado confirmó que el SDK rechazaba `paid_out_of_band=false`. Se omitió ese parámetro, usando el cobro normal de Stripe. Los dos intentos fallidos quedaron anulados y sus suscripciones canceladas; el precio sintético del primer intento fue archivado con el conector. No se repitieron sus reservas canónicas ni se usaron clientes reales.

Ejecución aprobada `0c6117e6-296b-42d0-a887-0e4af60cf6a4`, despliegue `d961fcc4-a9e0-4b6e-9586-604cbcb33269`, Stripe 14.25.0/API 2023-10-16 sobre Bun 1.4.0:

- Cliente sintético `cus_VOPvcVyfOihsnD`, suscripción `sub_1UNd5nRzkK1jKKf3KDNIMD7b`.
- Línea `ii_1UNd5oRzkK1jKKf3ThrqHFsO`: 100 centavos USD sin descuentos. Dos POST del adaptador con misma clave devolvieron el mismo ID; sólo una línea pendiente y una línea en factura.
- Factura `in_1UNd5pRzkK1jKKf3IYWGAhfp`: `paid`, `amount_paid=100`, `amount_remaining=0`, transición de pago presente.
- Cargo con tarjeta `ch_3UNd5qRzkK1jKKf31QR6PJwz`: `paid=true`, importe 100 USD, `livemode=false`. El SDK verificó asociación a la factura; factura y cargo se volvieron a consultar independientemente con el conector.
- Suscripción de QA cancelada y precio inactivo, verificados tras el pago. Los recibos de prueba se conservaron. No hubo dinero real ni mensajes a huéspedes.

Evidencia reducida y sin secretos en `src/pin-ai/fixtures/fee-stripe-sdk-paid-20261006.json`; también prueba la lectura del formato moderno pagado en el adaptador. Este resultado no demuestra entrega HTTP del webhook, ledger PostgreSQL nativo o ejecución Node de API/worker. La Function terminó; su eliminación fue cancelada por el control de aprobación del conector y permanece detenida, sin cron, con política NEVER. Retirarla manualmente del entorno cuando corresponda; no redeployar una ejecución ya marcada ATTEMPTED.
