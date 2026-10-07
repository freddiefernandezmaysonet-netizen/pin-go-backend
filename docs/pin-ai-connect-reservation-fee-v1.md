# Pin AI: cargo por reserva desde Connect

Decisión vigente de Freddie, 2026-10-06. Sustituye el mecanismo de factura SaaS de `pin-ai-reservation-fee-v1.md`; esa prueba de tarjeta/factura no certifica este cobro.

## Regla comercial confirmada

- USD $1.00 al anfitrión por cada reserva con Pin AI activado, una vez por reserva canónica, sin importar su origen. Incluye reservas manuales; no excluir por proveedor o soporte de mensajería OTA.
- Descuento desde la cuenta Stripe Connect del anfitrión. No añadirlo a la factura SaaS ni cobrar a la tarjeta del huésped.
- Se conserva la ventana acordada: desde 24 horas antes del check-in, según fechas de la propiedad. Cancelaciones anteriores a la ventana no generan cargo; demos y propiedades de prueba se excluyen.
- Aceptación por propiedad al habilitar, con autorización del descuento Connect. Se necesita una versión nueva de consentimiento; la aceptación anterior de factura SaaS no autoriza el nuevo mecanismo.
- El cargo no amplía capacidades de Pin AI: en OTA sólo responde preguntas y escala problemas. No habilita modificaciones de reservas.

## Auditoría

Identity check se incorpora a `application_fee_amount` en el checkout inicial de Direct Booking (`public-booking.routes.ts`, `direct-booking-connect-fee.service.ts`). Reduce el importe del anfitrión sin aumentar el total del huésped. No existe ese checkout para los pagos realizados por una OTA.

Añadir Pin AI a esa comisión inicial adelantaría el descuento respecto de la ventana de servicio. Para conservar la ventana y el mismo mecanismo entre orígenes, el diseño corregido usa **Account Debits**: al vencer la ventana, la plataforma descuenta 100 centavos del saldo Connect del anfitrión hacia el saldo de Pin&Go. No cambia el checkout ni identity check.

Stripe documenta restricciones que deben verificarse por cuenta: responsabilidad de Pin&Go por saldos negativos, regiones compatibles, moneda predeterminada USD, consentimiento vinculante y saldo suficiente. No basta con `charges_enabled` o `payouts_enabled`, ni con que la cuenta sea Express. Account Debits tiene un costo adicional de Stripe que debe verificarse para Pin&Go. Referencia oficial: https://docs.stripe.com/connect/account-debits .

Si no hay saldo disponible, conservar el dólar pendiente por esa reserva y reintentar con evidencia actual e idempotencia; no marcarlo pagado ni sustituirlo por una tarjeta, factura SaaS o cargo al huésped. Los fondos que una OTA paga fuera de Stripe no aparecen automáticamente en el saldo Connect. Este límite no elimina la obligación de la reserva ni autoriza retirar directamente de la cuenta bancaria del anfitrión.

## Corrección local realizada

Se retiraron del worker de reservas la ejecución/importaciones del ciclo de factura SaaS y del webhook Stripe su conciliación Pin AI de facturas. El webhook y worker conservan sus demás operaciones. El texto de activación en Dashboard ahora describe cargo por reserva de cualquier origen desde Connect y señala que su cobro sigue pendiente de habilitación.

Los servicios, tests y fixtures anteriores de invoice quedan como evidencia de una implementación descartada; no son certificación ni punto de ejecución del nuevo cargo. El modelo de ledger, los gates de activación y el selector anterior todavía deben reemplazarse/adaptarse: no habilitar el rollout comercial con las variables anteriores. No se cambiaron flags, consentimientos o datos en producción.

## Implementación siguiente

1. Validar Account Debits en el sandbox con una cuenta Connect sintética y saldo de prueba; certificar permisos, moneda, saldo insuficiente, resultado Payment e idempotencia. No repetir prueba de factura/tarjeta.
2. Sustituir estados y referencias de invoice/subscription por cuenta Connect fijada, identidad del débito/Payment y estados pendientes/cobrado/revisión. Mantener clave única por reserva, lease y conciliación de respuestas inciertas.
3. Cambiar consentimiento/versionado y gates del servidor para autorización Connect. El selector del cargo debe ser independiente del origen de la reserva y de los permisos de modificaciones/mensajería.
4. Conectar registro periódico y cobro Connect; verificar conciliación, aislamiento por organización, reintentos sin duplicados y PostgreSQL nativo. Si Account Debits no es compatible con una cuenta, bloquear la habilitación comercial y mostrar la causa; no introducir otro medio de cobro sin decisión del usuario.
5. Actualizar Dashboard Billing y retirar el código de invoice descartado antes de publicar. Pruebas locales, revisión, migraciones y despliegue controlado; sin mezclar esta corrección con early/late checkout.

## Certificación sandbox, 2026-10-06

Cuenta plataforma de prueba: `acct_1SmdRdRzkK1jKKf3`. Cuenta Connect existente: `acct_1UMuCTRzkKtvlWsd`, US/USD, responsabilidad de pérdidas application. No se usó producción.

Consulta inicial: USD 0 disponible y USD 24 pendiente. Para disponer saldo ficticio se creó exclusivamente una carga de financiación de prueba de USD 5 con `tok_bypassPending`: `ch_3UNdO3RzkKtvlWsd02mp5UzE`. Esa financiación no es el cargo comercial de Pin AI ni requiere cobrar una tarjeta para cada reserva.

Account Debit por reserva sintética `qa-pin-ai-connect-20261006-v1`: `py_1UNdO4RzkK1jKKf3MupiM9op`, amount 100, USD, paid true, succeeded, livemode false, source cuenta Connect. Movimiento de Connect `txn_1UNdO5RzkKtvlWsdDmtfNtOt`: amount/net -100, transferencia `tr_1UNdO4RzkKtvlWsdsZHZdSE5`. Disponible resultante USD 4; pendiente USD 24.

La primera comprobación falló después del débito porque SDK 14.25.0 / API 2023-10-16 devuelve un Payment con ID py_ y object charge, no object payment. Se diagnosticó en lectura antes de reintentar; se corrigió el reconocimiento y comprobación del source string/objeto. El reintento con la misma clave `pin-ai-connect-qa-v1:qa-pin-ai-connect-20261006-v1` devolvió el mismo Payment; saldo disponible antes/después del reintento 400/400 centavos. No hubo segundo débito. Evidencia en deployment Railway `bea08c31-f834-4697-938f-3bc8589948a0`, log 18:50:57Z.

Script QA limitado a IDs sandbox y credencial test; CLI expira 19:46Z para impedir reutilizar la clave tras la retención de idempotencia. Tres tests locales aprobados (scope/reintento, responsabilidad incompatible, financiación sin saldo disponible) y compilación TypeScript estricta. El saldo insuficiente se verificó localmente, no mediante un segundo débito real fallido. Función temporal terminó, restart NEVER y sin cron; no se alteraron API, DB o flags comerciales.

Estado de la certificación Stripe: Account Debits e idempotencia confirmados en sandbox. No inferir costos de producción de las comisiones cero del sandbox.

## Integración local posterior

Implementado el ledger Connect y su migración adicional `20261006193000_pin_ai_connect_debit`: cuenta fijada al registrar la reserva, Payment único, inicio persistido del intento y generación de clave. Se preservan los campos SaaS como historia; la migración pone registros de aceptación anterior en revisión sin convertirlos a obligaciones Connect.

La nueva aceptación `pin-ai-connect-usd-1-reservation-v1` incluye autorización de descuento y reintento cuando exista saldo. Dashboard permite renovar aceptación incluso si la propiedad ya figuraba habilitada. Billing muestra pendiente Connect, pendiente de saldo, cobrado y revisión.

Registro independiente del origen/mensajería: Direct Booking, OTA incluyendo Vrbo, manual y otros orígenes; demos y propiedades de prueba excluidos. Ventana basada en los instantes canónicos de la reserva derivados del timezone de la propiedad. Se fija la cuenta Connect en la transacción de registro. El ciclo del worker, cada minuto y con lotes limitados, registra y cobra sin requerir un chat.

Controles nuevos por defecto apagados: `PIN_AI_CONNECT_DEBIT_ENABLED=true` y lista explícita `PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS` sin wildcard; requieren además los controles de propiedad/registro para acumular cargos. Las variables SaaS anteriores no habilitan Connect. No se cambió ninguna variable remota ni se aplicó la migración.

El cobrador usa lease/CAS, clave por reserva y generación, evidencia de Payment y cuenta/importe/moneda/metadata exactos. Saldo disponible menor de 100 centavos deja pendiente una hora. Si un rechazo definitivo de Stripe por saldo llega después de la comprobación, retira exclusivamente esa clave fallida y espera fondos con una nueva generación. Una respuesta perdida o fallo de persistencia conserva la clave original; reintenta dentro de 23 horas incluso si el dólar ya se descontó. Después de ese plazo detiene para revisión. Un cambio de cuenta antes del primer intento no redirige el cargo; requiere revisión. No existe fallback a tarjeta, SaaS, huésped o banco. El proveedor V1 restringe compatibilidad al corredor certificado US/USD y responsabilidad de pérdidas application.

Validación: 72 pruebas enfocadas de Connect/activación/rutas aprobadas; prueba de integración persistida Prisma + PGlite aprobada (registro, cobro, reserva manual sin chat, falta de saldo, aislamiento, desactivación e historial); TypeScript estricto de servicios/adaptador aprobado; bundles API/worker y build Dashboard aprobados, ESLint de ambos componentes aprobado. PGlite no certifica concurrencia en PostgreSQL nativo.

Pendiente antes de publicación: validar compatibilidad Connect en la habilitación de cada propiedad (hoy se comprueba antes del débito), conciliar operaciones que excedieron el plazo de replay y certificar concurrencia/recuperación en PostgreSQL nativo. Revisar además el caso cancelado después de abrir la ventana pero antes de que el worker registre el cargo, y el cierre de la ventana durante una interrupción del worker: no se infiere retrospectivamente servicio sin evidencia. No habilitar rollout hasta resolver esos casos y retirar el ejecutor SaaS histórico. Producción y la certificación early/late permanecen intactas.

## Continuación: compatibilidad al activar y recuperación, 2026-10-06

La activación de una propiedad verifica Account Debits con el proveedor Stripe existente antes de guardar consentimiento. Primero verifica permisos, organización, propiedad y revisiones; no contacta Stripe para usuarios o propiedades ajenos. La consulta externa ocurre fuera de la transacción SQL y al guardar se vuelven a verificar la cuenta y revisiones. Una cuenta ausente/incompatible impide activar (422); una verificación fallida impide activar (503). Saldo cero no impide habilitar una cuenta compatible. Desactivar no consulta Stripe. El Dashboard muestra la causa concreta y exige recargar antes de reintentar.

Validaciones de esta continuación: 33 pruebas enfocadas aprobadas, más una integración persistida Prisma/PGlite. La integración comprueba un cargo pendiente por reserva manual que sobrevive a cancelación y se liquida una sola vez tras una interrupción de cinco días al volver a haber saldo. La prueba de lease interrumpido comprueba que se espera su vencimiento y se recupera la misma petición. TypeScript estricto de los servicios, bundles API/worker, TypeScript del Dashboard, build y ESLint del componente pasan. No se repitieron movimientos Stripe ni workflows remotos.

PostgreSQL nativo sigue pendiente: el espacio de usuarios del entorno sólo mapea UID 0; `chown` a otro usuario falla con EINVAL, por lo que no se inició el servidor PostgreSQL local. PGlite no sustituye esta certificación.

Limitaciones que siguen abiertas antes de publicación: el selector sólo registra reservas activas dentro de la ventana actual. Una cancelación posterior a la apertura pero anterior al registro, o una interrupción que abarque toda la ventana sin ledger, no se recupera retrospectivamente con el código actual. Se necesita evidencia persistida del inicio de servicio/activación y cancelación para recuperar esas obligaciones sin inferir un servicio histórico a partir de la configuración actual. Los cargos ya registrados sí se conservan y recuperan. No declarar cerrado este bloque ni habilitar el cobro comercial todavía. También quedan la conciliación tras expirar replay y retirar los ejecutores históricos de factura SaaS.

## Continuación: constancia previa y recuperación de la ventana

Se añadió `PinAIServiceEnrollment` y migración `20261006200000_pin_ai_service_enrollment`, aún sin aplicar remotamente. La constancia se crea antes de abrir la ventana, para reservas activas elegibles de cualquier origen. Guarda fechas canónicas, apertura/cierre, organización/propiedad, cuenta Connect, aceptación y revisiones de activación. No es un cargo, no aparece en los totales monetarios y no contacta Stripe. No se hace backfill histórico.

El worker inscribe lotes de reservas futuras y procesa constancias vencidas, independientemente de que haya conversación o de que ahora haya terminado la ventana. En una transacción Serializable, una cancelación anterior o simultánea a la apertura excluye la reserva. Una cancelación posterior con fecha persistida conserva la obligación; el ledger toma la apertura documentada como inicio del servicio. Un ledger por reserva y constancia resuelta evitan registrar otro dólar. El cobrador y selector impiden descontar antes de `serviceStartedAt`.

Fechas/cuenta/origen/ámbito cambiados, cancelación sin fecha fiable e historial incompleto quedan `NEEDS_REVIEW`. Las revisiones posteriores deben tener auditoría completa; cualquier cambio anterior o simultáneo a la apertura requiere revisión. Desactivaciones con auditoría posteriores a la apertura no borran la obligación. Billing informa las constancias que requieren revisión y aún no tienen cargo.

Validación final de esta continuación: 34 pruebas enfocadas aprobadas; integración previa de activación aprobada; nueva integración persistida Prisma/PGlite con seis casos internos aprobada. Cubre ausencia de cobro anticipado, cancelación previa/exacta/posterior, recuperación sin chat después de toda la ventana, fechas/cancelación inciertas, activación antes/después y ausencia de inferencia histórica. TypeScript estricto, bundles API/worker, build/tipos Dashboard y ESLint de Billing pasan. El runner local usa una instancia PGlite nueva por suite, debido a la limitación de sesiones/statement preparados del socket; no certifica concurrencia nativa.

Límite restante: la constancia previa sólo existe si el worker llegó a inscribir la reserva antes de la apertura. Reservas creadas y canceladas durante una interrupción completa o dentro de la ventana antes del primer registro siguen sin evidencia suficiente para recuperarlas automáticamente. El siguiente paso es registrar evidencia en los flujos canónicos de creación/cancelación, sin asumir un servicio histórico ni cobrar antes de la ventana. Las constancias con fechas/revisiones cambiadas quedan para revisión y no se reprograman automáticamente en esta versión.

También siguen pendientes PostgreSQL nativo, conciliación de respuestas inciertas fuera de replay y retirar los ejecutores de factura SaaS. Producción, flags y certificación early/late siguen sin cambios. Antes de desplegar API/worker hay que aplicar esta migración junto a las previas, manteniendo el rollout apagado hasta certificar el ciclo integrado.

## Continuación: evidencia en la transacción de reserva

El servicio canónico `ingestReservation`, usado por Direct Booking, Channex y creación manual del Dashboard, registra la evidencia tras una creación/cambio efectivo, dentro de su transacción. La creación manual legacy también lo hace. Los servicios de cancelación huésped, cancelación manual host y cancelación legacy capturan el servicio activo inmediatamente antes de aplicar la cancelación, con un instante anterior al cierre para no inventar servicio en una cancelación exactamente en la apertura.

La función `capturePinAIReservationService` usa la transacción existente y bloquea la fila de reserva antes de consultar el estado actual. Con los controles apagados retorna sin consultar nuevas tablas. Inscribe futuras reservas sin generar un cargo; si la ventana ya abrió y la asistencia está habilitada, registra el dólar pendiente. No crea transacciones anidadas, no llama Stripe ni envía comunicaciones. Un fallo posterior revierte la evidencia junto con la reserva, y el registro único permite reintentar sin duplicar.

Las reservas OTA que ingresan directamente CANCELLED no acumulan un cargo. No se infiere una fecha de cancelación OTA a partir de `externalUpdatedAt`, que puede ser sólo la fecha de una revisión. Cuando una constancia previa requiere esa fecha y `cancelledAt` no es fiable, queda para revisión. Se conserva el control existente de cancelar/actualizar reservas OTA, sin ampliar capacidades de Pin AI sobre ellas.

Validación: 53 pruebas enfocadas de facturación, activación, ingreso y cancelación aprobadas; integración persistida con nueve casos internos aprobada, incluyendo todos los orígenes dentro de la ventana, creación seguida de cancelación sin worker, rollback del conjunto y reserva OTA inicialmente cancelada. TypeScript estricto de los servicios de evidencia y ciclo aprobado; bundles API/worker correctos. No se han certificado los handlers completos vía HTTP ni concurrencia PostgreSQL nativa; las pruebas persistidas llaman la misma función transaccional que invocan esos handlers. No se hicieron movimientos Stripe, publicaciones, migraciones remotas o despliegues.

Pendientes de cierre: PostgreSQL nativo, conciliación fuera del plazo de replay, ejecutores SaaS históricos y revisión de eventos OTA sin timestamp fiable/constancias con fechas modificadas. La evidencia sólo se guarda si la propiedad tenía aceptación vigente y los controles comerciales estaban habilitados al procesar la reserva; no se reconstruye retrospectivamente un servicio inexistente o no autorizado. Los cambios permanecen locales y el rollout comercial debe continuar apagado.

## Continuación: conciliación cuando vence el replay

Después de 23 horas desde el inicio de una petición incierta, el cobrador no vuelve a crear el débito. El proveedor busca Payments en el historial de saldo de la plataforma, con paginación y ventana temporal del intento original. La búsqueda se limita a cinco páginas y veinte lecturas de Payments. Un único Payment en una búsqueda completa debe superar las comprobaciones existentes de reserva, organización, propiedad, cuenta, aceptación, importe, moneda y estado antes de marcar el cargo PAID.

Una búsqueda vacía, incompleta, con varias coincidencias o evidencia contradictoria queda en revisión, sin crear un débito ni avanzar la generación de la clave. Un error de lectura conserva el intento y permite repetir únicamente la consulta. Los registros anteriormente detenidos sólo por CONNECT_REPLAY_WINDOW_EXPIRED pueden conciliarse; los demás estados de revisión no se reabren automáticamente. El ciclo del worker incluye esos casos específicos. Incluso una búsqueda completa sin coincidencias no autoriza otro cargo.

Referencias oficiales verificadas: https://docs.stripe.com/api/idempotent_requests y https://docs.stripe.com/api/balance_transactions/list . La consulta está implementada con SDK/API existentes; la lectura real de ese historial para Account Debits aún requiere certificación sandbox.

Se retiraron los siete archivos ejecutables/tests del mecanismo descartado de invoice SaaS. Sus resultados quedan en documentación, fixtures e historial git; las columnas de invoice se conservan por compatibilidad/evidencia histórica y no autorizan el cobro Connect.

Validación: 43 pruebas enfocadas aprobadas, integración persistida con diez casos internos aprobada, TypeScript estricto y bundles API/worker correctos. La integración comprueba un intento con respuesta perdida y conciliación tras 48 horas usando datos SQL persistidos y proveedor simulado, sin segunda creación. No se hizo un nuevo débito real.

Preparada `src/pin-ai/fee-connect.native.database.test.ts`: requiere PIN_AI_NATIVE_DB_TEST=true y una base PostgreSQL nativa aislada llamada pin_ai_activation_test en localhost con la migración actual aplicada. Comprueba ocho registros concurrentes desde dos clientes, un ledger único, dos cobradores concurrentes, una sola petición y recuperación posterior. Compila, pero NO se ha ejecutado ni certificado. La prueba rechaza PGlite/wasm y una URL fuera del ámbito local. El intento adicional de crear un namespace de usuario local también fue rechazado por el sistema (Operation not permitted); no se alteraron permisos ni servicios externos.

Pendientes antes de publicación: ejecutar esta certificación nativa, validar la lectura de conciliación en Stripe sandbox y completar los casos de revisión documentados (OTA sin timestamp fiable y constancias con fechas/revisiones modificadas). La migración y los cambios siguen sin publicar/aplicar/desplegar; rollout comercial apagado.

## Continuación: prueba sandbox de conciliación preparada

Se añadió `src/scripts/certify-pin-ai-connect-reconciliation-sandbox.ts`. Consulta únicamente el débito sandbox existente y el historial de saldo con SDK 14.25.0 / API 2023-10-16. El adaptador recibe una fachada que sólo expone lecturas, sin método para crear débitos. Comprueba cuenta, importe, estado, búsqueda completa, coincidencia única y saldo disponible sin cambios. Dos pruebas locales y la compilación pasan. No certifica el ledger comercial: el débito sintético original no contiene toda su metadata contractual.

La consulta directa del débito por el conector confirmó paid=true y 100 centavos; su permiso insuficiente para leer el historial impidió certificar la búsqueda por ese medio. Se preparó la función temporal existente `pin-ai-fee-certification-once`, exclusivamente en el entorno Railway `certification`, con credencial sandbox ya existente, identificador de ejecución y caducidad 2026-10-07T00:30:00Z. Sólo hay dos cambios pendientes: código de esa función y PIN_AI_CERTIFICATION_RUN. API, PostgreSQL, volúmenes y variables compartidas siguen sin cambios.

El despliegue fue rechazado por la revisión automática: la autorización para preparar la prueba no se consideró autorización explícita para desplegar esta ejecución. No se reintentó ni se ejecutó por otro mecanismo. Patch pendiente `1fff6d39-139f-46c7-8e8e-781e3afdc3ec`, sin desplegar. La certificación real de lectura y la prueba PostgreSQL nativa siguen pendientes; no se generó un nuevo débito ni se habilitó el rollout.

## Resultado: lectura real de conciliación certificada en sandbox

Tras autorización explícita, la confirmación de la herramienta fue cancelada y el patch permaneció pendiente. El usuario completó posteriormente el despliegue en Railway: `65616d2a-e68e-4156-8c5d-9fbd050322ef`, SUCCESS, creado 2026-10-06T20:37:35Z. Se verificó que ya no hay cambios pendientes en certification.

El log estructurado de 2026-10-06T20:37:41Z confirma `certificate=CONNECT_RECONCILIATION_READ_ONLY`, `certified=true`, `livemode=false`, `amountCents=100`, `complete=true`, `balanceUnchanged=true`, Payment `py_1UNdO4RzkK1jKKf3MupiM9op`, cuenta `acct_1UMuCTRzkKtvlWsd`. La consulta encontró exactamente el débito existente mediante el historial real y el adaptador SDK/API del backend, sin otro débito.

Este resultado cierra la certificación de lectura de conciliación sandbox. `productionLedgerCertified=false`: no certifica todo el ledger comercial ni sustituye la prueba pendiente de concurrencia/recuperación en PostgreSQL nativo. Producción y rollout comercial continúan sin cambios.

## Preparación: concurrencia nativa en CI aislado

Se preparó `.github/workflows/pin-ai-connect-native-certification.yml`, con PostgreSQL 16 desechable en el runner GitHub, base `pin_ai_activation_test` en 127.0.0.1 y pool de ocho conexiones por cliente. Instala dependencias del lockfile, genera Prisma, inicializa el esquema actual, compila y ejecuta exclusivamente el contrato nativo. No recibe secretos ni conecta proveedores de pagos. Permisos GitHub contents:read. Puede correr en PR a main para los paths afectados o mediante workflow_dispatch cuando esté disponible.

La prueba usa dos clientes Prisma, ocho registros simultáneos, dos cobradores concurrentes y una respuesta simulada perdida después del débito; exige un ledger, una sola creación y conciliación posterior a 48 horas sin otra creación. El proveedor es simulado: esta certificación verifica persistencia y concurrencia PostgreSQL, complementada por la prueba Stripe sandbox ya aprobada. El esquema se crea con db push; no certifica el recorrido completo de migraciones sobre una base existente.

Validación local: TypeScript estricto y estructura/configuración YAML aprobados; URLs con host remoto o nombre de base diferente se rechazan antes de conectar. Sin habilitación explícita el test queda SKIP, por lo que aún NO se certificó concurrencia nativa. El entorno local no dispone de Docker/Podman y sigue limitado al UID 0. El workflow se mantiene local hasta publicar la rama para su ejecución en CI. No modifica Railway ni producción.

## Resultado: PostgreSQL nativo certificado en PR Draft #371

Con autorización explícita se publicó el árbol local exacto `4faf83484d46baba0cb21e84107f05dee07f2b3d` mediante la conexión GitHub como commit `96a775ff6a801c59d3a1410bffac2941bb07cbd5`, rama `agent/pin-ai-property-activation-v1`, PR Draft https://github.com/freddiefernandezmaysonet-netizen/pin-go-backend/pull/371 . No se fusionó ni desplegó producción.

Run nativo `37533568885`, job `112508734025`: inicialización PostgreSQL 16, compilación y contrato concurrente aprobados. Log 2026-10-06T21:24:20Z: tests=1, pass=1, fail=0, skipped=0. Certifica un ledger y una sola petición simulada bajo concurrencia, con recuperación tras 48 horas sin duplicación. Los límites de schema/migraciones y proveedor simulado indicados arriba continúan aplicando.

La primera ronda de CI expuso workflows que leen exclusivamente schema.prisma; los dos modelos de billing se movieron allí desde el archivo separado, preservando el esquema SQL. Se añadió comprobación explícita del candidato conciliado para compiladores con noUncheckedIndexedAccess. Validación Prisma tanto de archivo como de directorio, compilación de host inbox y 25 pruebas de Connect pasan localmente.

También se identificaron dos fallos de Demo Center ya presentes en la base c97cb69: un contrato estático busca resolveOrganizationPrimaryAdmin mientras Direct Booking usa resolveDirectBookingHostRecipient; el contrato de conversación llama el gateway con el reloj actual sobre una reserva que empieza más de 24 horas después. Los archivos y el control de ventana involucrados son idénticos a la base. Esos fallos no autorizan ampliar la ventana real ni cambiar el cobro; deben revisarse como fixtures/contratos de Demo. Se mantiene Draft hasta cerrar/verificar CI.

## Continuación: cierre de los cinco checks pendientes

El commit publicado a5d7b953 terminó con 51/56 workflows aprobados; la concurrencia nativa volvió a pasar sin tests omitidos. Tres checks fallaron por controles de alcance heredados (OTA listing discovery, E15 y Exit Closure A). Se preparó un verificador exclusivo del PR #371/repositorio/rama/base revisada, con conjunto exacto de 57 archivos, hashes de las seis migraciones/esquema/worker y congelación de PMS, otros workers, transportes Channex y TTLock Brain. Rechaza otra identidad, archivos faltantes/adicionales o bytes distintos. Las comprobaciones de runtime y fingerprint posteriores permanecen activas.

El workflow de Host Incident Foundation ahora aplica las seis migraciones nuevas sobre su base desechable antes de generar el cliente y ejecutar tests. El fallo observado era pinAIEnabled ausente al crear Organization, porque su setup cargaba únicamente el esquema base.

Sólo se corrigieron fixtures/contratos de Demo: la reserva sintética comienza seis horas después del reloj actual, dentro de la ventana existente; el test de destinatario comprueba resolveDirectBookingHostRecipient y su delegación a resolveOrganizationPrimaryAdmin. No se cambia la disponibilidad del producto ni el enrutamiento de emails. Tres tests del verificador de alcance y 26 tests de precheckin pasan; los cuatro workflows tienen YAML y bloques shell válidos. La conversación demo y el setup de incidentes requieren recertificación PostgreSQL en CI.

En de33b496, OTA listing discovery, E15, Exit Closure A, Demo Center completo y concurrencia Connect nativa pasaron. Host Incident Foundation aprobó su validación de migraciones y las pruebas PostgreSQL/API; sus compilaciones/regresiones continuaban. Al tocar el workflow de listing discovery se activó además OTA Initial Distribution Enablement: sus pruebas funcionales, tipos y fingerprint pasaron, pero rechazó el alcance del PR. Se amplió únicamente su reconocimiento del mismo verificador exacto; el manifiesto revisado ahora contiene 58 archivos. No se retiró ninguna prueba ni se cambiaron transportes OTA.
