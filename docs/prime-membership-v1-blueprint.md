# Pin&Go Prime — dashboard de miembros y búsqueda con Pin AI

Fecha: 27 de octubre de 2026, America/Puerto_Rico.
Estado: diseño comercial en definición con el fundador. Piloto privado de búsqueda conversacional desplegado para Demo. Las reglas comerciales y el registro descritos a continuación están acordados para su implementación futura; todavía no están activos.

## Decisiones del fundador

- Prime es una membresía para viajeros con dashboard exclusivo.
- El dashboard tendrá un buscador de propiedades disponibles que acepten Prime.
- Pin AI será la interfaz principal de búsqueda: conversación, resultados visuales y refinamiento.
- Una tarjeta física personal reutilizable es uno de los beneficios previstos.
- Los proveedores y el personal de limpieza son otra línea de desarrollo; no condicionan esta primera versión.

## Reglas comerciales confirmadas el 27 de octubre de 2026

| Concepto | Decisión del fundador |
| --- | --- |
| Plan anual | Confirmado: USD 89.99 por año, cobrados como importe anual. |
| Plan mensual | Confirmado: USD 9.99 al mes. Se ofrecen ambos planes, mensual y anual. |
| Canales de compra | Página de reservas de cualquier anfitrión o directamente en pin-ngo.com. |
| Comisión por captación | El anfitrión recibe el 40% de los pagos de la membresía originada en la página de su propiedad, incluyendo las renovaciones pagadas mientras siga activa. La atribución y el historial se registran por propiedad; la liquidación se integra con Stripe Connect. |
| Medio de liquidación al anfitrión | Confirmado por el fundador: Stripe Connect, utilizando la cuenta conectada existente del anfitrión. El abono bancario sigue la configuración de pagos de esa cuenta y la disponibilidad de fondos. |
| Gestión del anfitrión | Todo se gestiona por propiedad: participación, descuento, beneficios, membresías referidas y comisiones. |
| Descuento obligatorio | Cada propiedad participante tiene su propio porcentaje, elegido por el anfitrión entre 5% y 20%. |
| Base del descuento | Únicamente el precio del alojamiento por noche. El porcentaje no se aplica a limpieza ni a otros cargos. El tratamiento de impuestos pertenece al cálculo de la cotización. |
| Uso desde la primera reserva | Confirmado: una membresía adquirida durante el checkout permite aplicar el descuento Prime en esa misma reserva, con el pago de la membresía confirmado. |
| Primera tarjeta y envío | Incluidos en la membresía, sin cargo adicional para el miembro. |
| Cobertura de envío | Pendiente de evaluar los costos de envío, según indicó el fundador. Aún no se han seleccionado destinos. |
| Reemplazo por extravío | USD 5 por reemplazar una tarjeta extraviada. |
| Cancelación de membresía | Sin permanencia mínima; conserva beneficios hasta terminar el período ya pagado. |
| Reservaciones ya confirmadas | Conservan el precio acordado y el acceso correspondiente a la estancia aunque se cancele la renovación de Prime. |

La venta de la membresía debe conservar la propiedad de origen y el anfitrión correspondiente para atribuir los pagos de membresía. Las comisiones recurrentes se registran en esa propiedad de origen y se liquidan mediante Stripe Connect. La comisión remunera esa adquisición; el descuento beneficia al huésped al reservar alojamiento participante. El documento no define aún las reglas para una suscripción cancelada que se reactiva, los ajustes por reembolsos ni los detalles de integración del reparto recurrente en Connect. La gestión por propiedad corresponde a las funciones del anfitrión; el miembro mantiene su cuenta Prime y su tarjeta personal reutilizable para viajar entre propiedades participantes.

Ejemplo ilustrativo del descuento: tres noches de USD 150 producen un subtotal de alojamiento de USD 450. Con 10% Prime, el descuento es USD 45 y el alojamiento queda en USD 405. Limpieza y otros conceptos se incorporan por separado. Este ejemplo no constituye una tarifa real ni fija un tratamiento fiscal.

## Alta del miembro: flujo confirmado

La referencia al flujo del cleaner significa específicamente **recibir el email de bienvenida y crear la contraseña desde ese correo**. Este es el recorrido comercial acordado:

1. El cliente compra la membresía desde uno de los canales establecidos.
2. Se confirma el pago de la membresía.
3. Recibe un email de bienvenida a Pin&Go Prime con el enlace personal para crear su contraseña.
4. Crea su contraseña y completa los datos requeridos, incluida su dirección de envío.
5. Entra a su dashboard Prime y utiliza sus credenciales para los siguientes accesos.

Se revisó el mecanismo actual de activación del cleaner en el commit indicado en «Evidencia y punto de partida»; el detalle está en la siguiente sección. Prime tendrá su identidad de miembro y sus permisos propios. Las invitaciones del piloto son una herramienta de prueba; el alta comercial acordada se inicia con la compra y el email de bienvenida.

El registro inicial incluye:

| Dato | Requisito acordado |
| --- | --- |
| Nombre y apellidos | Identificación del miembro y destinatario de su tarjeta. |
| Correo electrónico | El utilizado en la compra, ya cargado en el registro. |
| Contraseña | Creada por el cliente desde el enlace de bienvenida. |
| Teléfono | Con código de país. |
| Dirección de envío | Calle y número; apartamento/unidad si aplica; ciudad; estado, provincia o región; código postal cuando corresponda; país. |

La dirección se solicita **durante el registro inicial**, según la aclaración expresa del fundador, para poder enviar la tarjeta física de acceso. Idioma y preferencias de viaje pueden completarse después desde el dashboard.

## Auditoría del registro del cleaner y adaptación propuesta

Revisión de código, sin modificaciones a producción, envío de mensajes ni creación de cuentas:

- `src/services/cleaner-account.service.ts`: genera un enlace aleatorio, guarda su hash, comprueba correo y vigencia, valida y guarda la contraseña mediante hash, crea la cuenta y consume los enlaces pendientes. El enlace actual del cleaner vence a las 48 horas y depende de su asignación de limpieza y de una reserva activa.
- `src/routes/cleaner-account.routes.ts`: presenta el formulario de correo/contraseña y, al completar la activación, ofrece entrar a «Mis limpiezas».
- `src/services/cleaning-confirmation-dispatch.service.ts` y `src/routes/cleaning-confirm.routes.ts`: en el flujo revisado, el enlace se transporta con la confirmación de limpieza por SMS y conduce a la activación. Esta auditoría no encontró en ese recorrido un email de bienvenida del cleaner listo para reutilizar.

La experiencia solicitada para Prime sigue siendo **email de bienvenida después del pago**, con botón «Crear mi contraseña». Se reutilizará el patrón de enlace de un solo uso, validación y contraseña protegida; la implementación debe vincularlo con el miembro y su compra de Prime. Las dependencias de limpieza y el rol CLEANER pertenecen al servicio existente.

Detalles técnicos propuestos para implementar el alta, aún sin activar:

1. La confirmación de pago validada por el servidor identifica la compra, el correo y el anfitrión de origen, si existe. Repetir la notificación del mismo pago conserva la misma cuenta y no genera otra comisión.
2. El email de bienvenida permite completar la contraseña, el perfil y la dirección. El enlace tendrá vencimiento y recuperación/reenvío; el plazo de Prime se definirá al implementar, sin trasladar automáticamente la regla de 48 horas del cleaner.
3. La cuenta permite iniciar sesión una vez completado el registro. La gestión del envío requiere la dirección completa y la asociación de la tarjeta con el miembro.
4. Un fallo de entrega del email debe poder recuperarse sin cobrar otra vez. Si el correo ya pertenece a una cuenta Prime, se deberá recuperar o vincular el acceso verificado, conservando sus viajes.

La cuenta, la suscripción, el envío de la tarjeta y los permisos de cada estancia tendrán estados separados para mostrar al miembro qué está realmente listo.

### Recuperación de pago y registro: recorrido propuesto

La compra debe poder recuperarse conservando la misma identidad, suscripción y pago. El requisito de membresía pagada antes del alta sigue vigente. La siguiente presentación concreta los fallos y las acciones que puede realizar el miembro; todavía requiere implementación.

| Situación | Qué muestra Prime | Cómo continúa el cliente |
| --- | --- | --- |
| Primer pago rechazado o sin completar | «Tu pago no se ha completado». | Volver al pago existente y corregir el método o completar la acción solicitada por Stripe. No se concede acceso Prime por iniciar el checkout. |
| El navegador regresa antes de confirmar el pago | «Estamos confirmando tu pago». | Consultar el estado verificado del servidor; no solicitar otra compra mientras se resuelve la operación existente. |
| Pago confirmado, correo de bienvenida no recibido | «Membresía pagada · completa tu registro». | Reenviar el enlace al correo asociado a esa compra, con controles de frecuencia. El reenvío no cobra otra vez ni crea otra membresía. |
| Enlace de bienvenida vencido | «Solicita un nuevo enlace para continuar». | Emitir otro enlace de un solo uso al correo asociado y retirar los enlaces de activación anteriores. |
| Registro interrumpido | «Completa tu perfil y dirección». | Retomar el registro con acceso verificado y conservar los datos ya guardados. |
| Cuenta Prime existente | Acceso o recuperación de la cuenta correspondiente. | Conservar viajes e historial; comprobar la suscripción existente antes de ofrecer otra compra. |

Los mensajes sobre una compra concreta solo se muestran con un contexto de compra o cuenta verificado. Un formulario público de reenvío devuelve una respuesta neutral; escribir un correo no permite consultar pagos ni entrar a esa cuenta. Corregir el correo de una compra exige verificar la titularidad antes de cambiar el destino del enlace.

El correo de bienvenida es responsabilidad del flujo de alta de Pin&Go. El recibo de Stripe y la bienvenida cumplen funciones diferentes. El envío y sus reintentos se registran para recuperar fallos de entrega; una nueva notificación del mismo pago no debe provocar otra bienvenida automática, cuenta, tarjeta ni comisión.

## Ciclo de suscripción: decisiones confirmadas y detalles propuestos

El fundador confirmó la cancelación sin permanencia mínima, la conservación de beneficios hasta terminar el período pagado y el respeto al precio y acceso de las reservaciones ya confirmadas. La tabla distingue esas decisiones de los detalles operativos todavía propuestos.

| Situación | Comportamiento | Estado de diseño |
| --- | --- | --- |
| Primer pago confirmado | Enviar la bienvenida y permitir completar el registro. | Confirmado. |
| Membresía vigente | Mostrar el plan elegido, la fecha de próxima renovación y los beneficios disponibles. USD 9.99 por período mensual o USD 89.99 por período anual; renovación automática con condiciones mostradas antes de comprar. | Ambos planes y precios confirmados; recorrido operativo propuesto. |
| El miembro cancela la renovación | Permitir cancelación sin permanencia mínima; conservar beneficios hasta terminar el período ya pagado. Mostrar la fecha exacta de finalización. | Regla comercial confirmada. |
| Falla una renovación | Avisar y permitir actualizar el método de pago. Respetar el período previamente pagado; al vencer, suspender beneficios para nuevas reservas. Reintentos y cualquier período de gracia quedan por definir. | Recorrido de recuperación propuesto. |
| La membresía vence | Mantener acceso a cuenta, recibos, viajes existentes y reactivación; restringir nuevos beneficios Prime hasta un nuevo pago confirmado. | Recorrido de cuenta propuesto; los viajes confirmados están protegidos por la regla siguiente. |
| Ya existen reservaciones confirmadas | Conservar el precio aceptado y el acceso correspondiente a esas estancias, sin cancelarlas ni retirar su acceso por cancelar la renovación de Prime. Cambios posteriores y nuevas reservas requieren sus propias validaciones. | Regla comercial confirmada. |

Cancelar la próxima renovación de Prime conserva las reservaciones confirmadas. Los beneficios continúan hasta terminar el mes o el año ya pagado, según el plan; esta regla no define por sí sola un reembolso proporcional. La primera tarjeta y su envío incluidos no imponen permanencia mínima. La comisión del anfitrión sigue vinculada a pagos de membresía efectivamente confirmados; los ajustes por reembolsos y disputas continúan pendientes.

Al implementar, las condiciones aceptadas de una reservación deberán conservarse para respetar su precio y acceso aunque la membresía venza antes o durante la estancia. Una comprobación genérica de «membresía vigente ahora» no debe retirar ese derecho ya adquirido. Siguen aplicando los controles propios de la reservación, la identidad, la tarjeta y el horario autorizado. El código local preliminar de condición de pago deberá alinearse con esta regla antes de cualquier integración con accesos.

### Renovación fallida y recuperación mediante Stripe: propuesta

Desde «Mi cuenta → Membresía», mostrar el estado del pago, el importe pendiente, el período al que corresponde y «Actualizar método de pago» o «Completar pago», según la acción disponible. La sesión de gestión de facturación debe corresponder al miembro autenticado y a su cliente de Stripe en el contexto de cuenta correcto.

Stripe Billing puede gestionar los reintentos de cobro y proporcionar un portal para actualizar el método de pago. La integración de Prime debe consultar el resultado real y la acción requerida, y reflejarlos en la cuenta. El calendario y el resultado al agotar los reintentos deben validarse antes de activar Prime; no se modifica la configuración global usada por otras suscripciones con este diseño. Una actualización del método de pago debe afectar al que utilizará realmente la suscripción.

Propuesta de comportamiento de Prime:

1. Registrar el fallo y presentar una acción de recuperación. Proponer un aviso por email con acceso al recorrido verificado de la cuenta, evitando mensajes duplicados por el mismo evento.
2. Respetar los beneficios hasta la fecha ya pagada. Al vencer ese período, restringir los beneficios para nuevas reservas hasta que haya un pago confirmado; no se añade un período gratuito por el mero hecho de existir reintentos pendientes.
3. Mantener la cuenta, los recibos y las reservas confirmadas con su precio y acceso acordados. La recuperación de la membresía no revoca por sí misma los permisos válidos de esas estancias.
4. Si Stripe requiere intervención del cliente, mostrar la acción necesaria. Si informa un próximo intento aplicable, mostrar su fecha; no inventar un calendario ni prometer que todos los rechazos se reintentan.
5. Al confirmarse el pago, actualizar la vigencia según el período efectivamente abonado, restaurar los beneficios correspondientes y registrar la comisión del referido una sola vez a través de la integración con Connect. Volver del portal de Stripe no basta para marcar el pago como completado.
6. Si los intentos terminan sin pago, mostrar el estado final y la opción de recuperación o reactivación que corresponda a la suscripción real. Una cancelación y cualquier cambio de plan pendiente deben reconciliarse antes de iniciar nuevas operaciones de cobro.

La propuesta no define todavía cantidades ni plazos de reintento, períodos de gracia, cobros de períodos vencidos ni la política comercial de reactivación. El miembro debe ver qué importe y período va a pagar antes de confirmar una recuperación que requiera su intervención.

### Evidencia para integrar la recuperación

- En la copia de backend `af10a9d9191480d6b5b65f902abeb41859ece21a`, `src/routes/billing.portal.route.ts` exige una sesión de administrador de organización y obtiene el cliente Stripe desde la suscripción de esa organización. Es un patrón de portal existente; Prime necesita su propio vínculo entre miembro, cliente y suscripción.
- `src/services/stripe-financial-event-ledger.service.ts` ya reconoce familias de eventos de suscripción, facturas y pagos, y distingue eventos nuevos de repetidos. Esto no prueba que el alta, la recuperación o las comisiones de Prime estén implementadas.
- La integración debe validar los eventos recibidos, su contexto de cuenta y su vínculo con el miembro. Debe conciliar el estado actual cuando lleguen notificaciones repetidas, tardías o fuera de orden. Una factura marcada como pagada fuera de Stripe no acredita por sí sola un cobro procesado ni fondos disponibles para repartir una comisión.
- Se revisaron las referencias oficiales de [reintentos de cobro](https://docs.stripe.com/billing/revenue-recovery/smart-retries), [eventos de suscripciones](https://docs.stripe.com/billing/subscriptions/webhooks), [portal del cliente](https://docs.stripe.com/customer-management) y [tipos de eventos](https://docs.stripe.com/api/events/types). El portal se utilizará con las funciones compatibles; los cambios programados de suscripción requieren comprobar sus limitaciones antes de habilitar acciones de cambio o cancelación.

La certificación deberá cubrir primer pago fallido, pago pendiente, bienvenida no entregada, enlace vencido, registro interrumpido, renovación fallida, actualización del medio de pago, pago recuperado, cancelación durante la recuperación y eventos duplicados o desordenados. Debe comprobarse que estos casos conservan las reservas y evitan cobros, altas o comisiones duplicadas. Esta revisión solo documenta el recorrido; no envía correos ni cambia la facturación en producción.

### Cambio entre mensual y anual: propuesta comercial

Propuesta para revisión del fundador: aplicar los cambios entre planes al terminar el período ya pagado. Ambos planes ofrecen los mismos beneficios, por lo que el miembro puede mantenerlos durante ese período y comenzar la nueva modalidad en la siguiente renovación. Los precios de USD 9.99 al mes y USD 89.99 al año están confirmados; esta regla de cambio todavía es una propuesta.

| Solicitud del miembro | Durante el período pagado | Al llegar la próxima renovación |
| --- | --- | --- |
| Mensual a anual | Conserva el mes pagado; se muestra el cambio programado y su fecha. Programar el cambio no genera un cobro. | Con el pago confirmado de USD 89.99, comienza un nuevo período anual. |
| Anual a mensual | Conserva el año pagado; se muestra el cambio programado y su fecha. Programar el cambio no genera un cobro. | Con el pago confirmado de USD 9.99, comienza un nuevo período mensual. |
| Deshacer un cambio pendiente | Vuelve a mostrar la renovación del plan actual y su importe, previa confirmación del miembro. | Se conserva la modalidad original, siempre que la renovación siga habilitada. |
| Cancelar la renovación con un cambio pendiente | Conserva los beneficios hasta la fecha pagada y se elimina el cambio programado. | No se inicia la otra modalidad ni se genera un nuevo cargo de renovación. |

Esta propuesta conserva íntegro el período pagado, por lo que el cambio programado no requiere prorratear ese período. No define una política general de reembolsos. La fecha efectiva debe proceder de la suscripción real y mostrarse de forma explícita; no se calcula suponiendo que todos los meses tienen treinta días.

Ejemplo ilustrativo: un miembro tiene el plan mensual pagado hasta el 10 de diciembre de 2026 y solicita el anual el 27 de noviembre. La pantalla indica «Hoy: USD 0 por este cambio. El 10 de diciembre: USD 89.99 por un año de Prime», con cualquier impuesto aplicable desglosado antes de confirmar. La solicitud no adelanta el cobro ni pierde los días del mes que ya pagó. Las fechas e importes del caso real deben venir del sistema de facturación.

### Presentación y condiciones del cambio propuesto

Desde «Mi cuenta → Membresía», mostrar plan actual, fecha hasta la que está pagado, nueva modalidad, importe de la siguiente renovación y fecha efectiva. El miembro confirma expresamente «Cambiar a anual el [fecha]» o «Cambiar a mensual el [fecha]». El resultado permanece visible como cambio programado hasta que se produzca la renovación correspondiente.

Si la renovación ya está cancelada, elegir otra modalidad debe mostrar que también se está autorizando una futura renovación; esa autorización no se presume por abrir la pantalla. Una membresía ya vencida necesita el recorrido de reactivación y pago, cuya política de atribución sigue pendiente.

La implementación deberá conservar una sola membresía y un solo cobro por período. Cambiar de modalidad no crea otra cuenta, otro envío de primera tarjeta ni otro origen comercial. El anfitrión y la propiedad que originaron la membresía conservan su atribución durante el cambio; la comisión recurrente del 40% se registra sobre cada pago efectivamente confirmado, no al programar el cambio. La base exacta y las liquidaciones siguen pendientes de definición.

Si el pago de la nueva modalidad falla, la pantalla no la presenta como pagada. Se conservan los derechos del período anterior hasta su vencimiento y las reservas ya confirmadas según las reglas acordadas. Los reintentos y cualquier período de gracia siguen pendientes; el cambio de plan no autoriza cobrar la modalidad anterior como alternativa sin consentimiento.

Antes de implementar, deben verificarse los recorridos mensual a anual, anual a mensual, deshacer cambio, cancelar renovación, pago fallido y notificaciones de pago repetidas. Los cambios simultáneos o solicitados cuando un cobro ya está en curso requieren volver a consultar el estado de facturación y mostrar la fecha efectiva válida, sin prometer modificaciones retroactivas.

## Tarjeta personal y envío: alcance del diseño

La tarjeta física personal reutilizable sigue formando parte de Prime y ya existe evidencia de una prueba temporal en Demo. La dirección inicial prepara su envío. El fundador confirmó que **la primera tarjeta y su envío están incluidos en la membresía, sin cargo adicional**. Si el miembro extravía la tarjeta, se cobra **USD 5 por el reemplazo**. Quedan por definir los destinos atendidos y la logística de entrega y reposición. El cargo acordado corresponde a extravío; los casos de defecto, daño o pérdida durante el transporte no están definidos por esta decisión.

El fundador indicó que necesita evaluar los costos de envío antes de decidir la cobertura. Puerto Rico, Estados Unidos y otros países son opciones por evaluar, no destinos ya aprobados. Para esa evaluación se propone comparar el costo por destino del franqueo o transporte, el empaque y el seguimiento, junto con el costo de la tarjeta. Las cotizaciones requieren origen del despacho, peso y dimensiones del envío y destinos de referencia. La evaluación queda pendiente; el diseño del dashboard y los recorridos de cuenta pueden continuar mientras se resuelve.

El diseño debe distinguir el acceso a la cuenta Prime, el estado del envío y el permiso físico de una estancia. Pagar la membresía permite iniciar el alta acordada; la habilitación de una cerradura requiere además el vínculo verificado entre miembro, tarjeta y reservación. Está confirmado que cancelar la renovación o vencer la membresía no elimina el precio ni el acceso correspondientes a reservaciones ya confirmadas. El permiso físico continúa sujeto a la validez de esa reservación y a su horario autorizado.

### Recorrido operativo propuesto de la tarjeta

La primera tarjeta incluida, el envío sin cargo y el reemplazo de USD 5 por extravío son decisiones confirmadas. La siguiente secuencia concreta su operación como propuesta para implementación futura.

| Etapa | Recorrido propuesto | Qué ve el miembro |
| --- | --- | --- |
| Preparación | Después del pago confirmado y del registro con dirección completa, crear una solicitud de primera tarjeta y asociar una tarjeta disponible al miembro. Repetir la confirmación del mismo pago no crea otro envío. | «Tarjeta en preparación · tarjeta y envío incluidos». |
| Envío | Registrar el despacho efectivo, destino, fecha y seguimiento cuando exista. El tiempo estimado se muestra solo cuando la operación logística pueda respaldarlo. | «Tarjeta enviada» y seguimiento disponible. |
| Recepción | Permitir al miembro autenticado confirmar que recibió la tarjeta vinculada a su cuenta. Distinguir esta declaración de una entrega registrada por el transportista. La confirmación de recepción no crea permisos de cerradura. | «Tarjeta recibida» y detalle de sus próximas estancias. |
| Reserva elegible | Verificar la vinculación de la reserva, las condiciones de pago e identidad aplicables, la compatibilidad del alojamiento y la tarjeta. Preparar el permiso para la ventana autorizada de esa estancia. | Propiedad, fechas, horario local y estado real del permiso. |
| Durante la estancia | Permitir el uso físico únicamente durante el horario autorizado y cuando la programación haya sido confirmada. Una modificación de fechas requiere actualizar y verificar el permiso correspondiente. | «Acceso confirmado para esta estancia», con inicio y fin. |
| Fin de la estancia | Finalizar el permiso de esa reservación. Conservar la tarjeta personal y su vínculo con el miembro para los viajes siguientes. | «Acceso de esta estancia finalizado»; la tarjeta sigue en su cuenta. |

La preparación de la tarjeta y la búsqueda de alojamiento son recorridos independientes: con la membresía vigente, el miembro puede buscar y reservar mientras espera la entrega. Si la estancia comienza antes de recibirla, solo se debe ofrecer un medio alternativo de acceso que ya esté habilitado y verificado para esa reserva y propiedad; la tarjeta en tránsito no equivale a acceso NFC listo. La afiliación a Prime y la compatibilidad NFC se muestran por separado.

La programación anticipada debe integrarse con la política existente de accesos; programar antes no adelanta el horario de entrada del huésped. La finalización por fecha prevista, una revocación por cancelación y una revocación por pérdida son hechos distintos y deben conservar su evidencia. No se debe declarar una revocación remota completada mientras siga pendiente de confirmación.

### Extravío y reposición: secuencia propuesta

1. El miembro entra a «Mi tarjeta» y reporta el extravío. Se identifica la tarjeta afectada y se muestra el efecto de la acción antes de confirmarla.
2. El sistema impide nuevas programaciones con esa tarjeta, cancela trabajos pendientes y solicita la revocación de los permisos que puedan seguir vigentes. También debe resolver programaciones que estuvieran en curso al recibir el reporte. El estado distingue «Pérdida reportada / bloqueo pendiente» de la revocación confirmada por las cerraduras afectadas.
3. Si hay una estancia en curso o próxima, presentar asistencia y el acceso alternativo únicamente cuando esté verificado. El reporte no cancela la reserva ni depende de pagar el reemplazo.
4. Ofrecer «Solicitar reemplazo · USD 5», confirmar la dirección de envío y solicitar el pago expresamente. Una confirmación de pago repetida mantiene la misma solicitud de reposición.
5. Asociar una nueva tarjeta al mismo miembro y a las reservas que sigan siendo elegibles, validando de nuevo ventanas y permisos. La tarjeta anterior queda excluida de nuevas asignaciones; encontrarla después no la reactiva automáticamente.

Los plazos, el transportista, los destinos y el tratamiento de daño, defecto o pérdida en tránsito siguen pendientes. El cargo de USD 5 corresponde al extravío por el miembro y no resuelve esos otros casos. La cobertura de envío debe estar visible antes de comprar para que el cliente compruebe que incluye su destino; la dirección completa se solicita durante el registro inicial, como ya se acordó.

### Evidencia técnica que condiciona la integración

Revisión de la copia de backend `af10a9d9191480d6b5b65f902abeb41859ece21a`, sin ejecutar operaciones de acceso:

- `prisma/schema.prisma`: `NfcCard` pertenece a una propiedad y contiene `ttlockCardId`; `NfcAssignment` vincula esa tarjeta con una reserva y una ventana. El modelo revisado no contiene el vínculo de la tarjeta personal Prime con el miembro ni el proceso de envío.
- `src/services/nfc.service.ts`: `assignNfcCards` selecciona tarjetas disponibles por propiedad y por etiquetas `Guest-` o `Cleaning Service-`. Las funciones `unassignAllNfcForReservation` y `unassignGuestNfcForReservation` revisadas finalizan asignaciones activas y devuelven la tarjeta al estado `AVAILABLE`.
- Prime necesita conservar la titularidad de la tarjeta después de cada estancia y mantener las asociaciones necesarias por cerradura. No se debe incorporar una tarjeta personal al ciclo de devolución al inventario de la propiedad ni asumir que el identificador del proveedor es universal entre cerraduras.
- El reporte de extravío debe cubrir permisos activos, programaciones pendientes y operaciones en curso. Las funciones revisadas que seleccionan solo asignaciones `ACTIVE` no constituyen por sí solas ese proceso completo.

La prueba NFC en Demo acredita el recorrido temporal ya probado; el ciclo de tarjeta personal, envío y reposición descrito aquí todavía requiere implementación y certificación.

## Decisiones pendientes, en orden de diseño

1. **Entrega de la tarjeta:** evaluar los costos de envío antes de decidir los destinos cubiertos y la logística, según indicó el fundador. Obtener origen del despacho, peso y dimensiones del envío y destinos de referencia para cotizar. La primera tarjeta y su envío ya están incluidos; el reemplazo por extravío tiene un cargo confirmado de USD 5.
2. **Cambios de plan:** ambos planes están confirmados: USD 9.99 al mes y USD 89.99 al año. Está documentada para revisión la propuesta de efectuar ambos cambios en la próxima renovación, conservando el período pagado y sin prorratearlo. La regla aún no se considera aprobada ni implementada.
3. **Suscripción:** revisar el recorrido propuesto de recuperación de pagos y registro; validar la configuración de reintentos de Stripe Billing, su resultado final y las reglas de reactivación. Cualquier período de gracia adicional requiere definición. La cancelación sin permanencia, el uso hasta finalizar el período pagado y la conservación de reservaciones confirmadas ya están acordados.
4. **Comisiones:** revisar la propuesta de base de cálculo, redondeo por pago y ajustes descrita en «Cálculo y registro de comisiones». Integrar el reparto recurrente con Stripe Connect, verificar la configuración de pagos de la cuenta conectada y definir recuperación de importes ya pagados y reactivaciones. El porcentaje recurrente de 40% y el uso de Stripe Connect están confirmados; los detalles nuevos son propuestas.
5. **Descuento y compra:** definir combinación con otras promociones y tratamiento de modificaciones de una reserva. Ya están confirmados el uso del descuento en la misma reserva en la que se compra Prime, la configuración independiente por propiedad, la obligatoriedad, el rango 5–20%, la base de alojamiento por noche y la conservación del precio de las reservas confirmadas.
6. **Tarjeta:** vinculación, recepción, reporte de pérdida, proceso de reposición y tratamiento de permisos pendientes o activos. El precio del reemplazo por extravío ya está definido; quedan pendientes las reglas para defectos, daños o pérdida durante el transporte.

Estas decisiones completan el diseño; no habilitan cobros, comisiones, envío de correos ni cambios de acceso en producción.

## Compra desde la página de reservas: regla confirmada y presentación propuesta

Están confirmadas la compra de Prime desde páginas de reserva y la aplicación del descuento a la misma reserva en la que se adquiere la membresía, con el pago de Prime confirmado. El huésped puede elegir entre USD 9.99 al mes y USD 89.99 al año. La presentación y coordinación técnica siguientes concretan esa regla para su implementación futura.

### Presentación al huésped

En una propiedad participante, después de seleccionar fechas y antes de confirmar el pago, mostrar:

- Precio regular de la estancia, calculado por el servidor.
- Porcentaje Prime configurado en esa propiedad y descuento sobre el subtotal de noches.
- Precio de la estancia con Prime, con limpieza, cargos e impuestos desglosados.
- Selector de plan y precio de la membresía, separado del importe de la reservación: USD 9.99 por el plan mensual o USD 89.99 por el plan anual, con las condiciones de renovación/cancelación.
- Importe a pagar hoy y comparación con la alternativa regular, usando cotizaciones completas y actuales.

Recorridos propuestos:

| Tipo de cliente | Acción y resultado propuestos |
| --- | --- |
| Miembro vigente | Se identifica con su cuenta. Se comprueba la membresía y se aplica el porcentaje de esa propiedad; reservar no genera otra compra de membresía. |
| Nuevo miembro | Elige expresamente añadir Prime. Al confirmarse el pago de la membresía, usa el descuento en esa misma reserva, según la regla aprobada. Recibe el email de bienvenida para crear contraseña y completar su registro y dirección. |
| Cliente que no elige Prime | Continúa con la cotización regular. |
| Cuenta Prime existente sin vigencia | Se verifica la cuenta y se ofrece reactivarla, conservando su historial; la reactivación y las comisiones asociadas requieren sus reglas pendientes. |

Ejemplo ilustrativo, sin impuestos ni otros cargos: tres noches de USD 150 suman USD 450 de alojamiento; 10% Prime descuenta USD 45; el alojamiento con Prime queda en USD 405.

| Opción | Alojamiento | Membresía a pagar hoy | Total ilustrativo hoy | Comparación con USD 450 sin Prime |
| --- | --- | --- | --- | --- |
| Mensual | USD 405.00 | USD 9.99 | USD 414.99 | USD 35.01 menos hoy; incluye un mes de membresía. |
| Anual | USD 405.00 | USD 89.99 | USD 494.99 | USD 44.99 más hoy; incluye un año de membresía. |

Los cargos y los impuestos del caso real deben incluirse en las cotizaciones antes de mostrar cualquier comparación total. La pantalla debe mostrar el coste completo del plan elegido: USD 9.99 para el mes o USD 89.99 para el año. Si el precio de la membresía supera el descuento inmediato, debe mostrar los importes reales y permitir elegir; no debe afirmar que siempre se ahorra dinero en esa compra. Comparando únicamente cuotas de membresía, doce pagos mensuales suman USD 119.88: el plan anual cuesta USD 29.89 menos, cobrados como una anualidad de USD 89.99.

### Coordinación propuesta del recorrido

La suscripción y la reservación conservan su identidad, importes y confirmaciones de pago. La experiencia debe permitir continuar desde el alta de Prime hacia la reserva sin repetir innecesariamente datos ya proporcionados. Si una persona ya es miembro, escribir un correo por sí solo no acredita la titularidad de su cuenta.

Antes de confirmar la reservación se vuelven a comprobar disponibilidad, precio, afiliación de la propiedad y elegibilidad Prime. Si la membresía se pagó pero la reserva no se completa, deben mostrarse ambos estados y un recorrido de recuperación; aún falta definir la resolución comercial de ese caso. Esta propuesta no promete un cobro único ni define todavía la coordinación concreta de pagos.

### Evidencia de la revisión del checkout actual

- `src/routes/public-booking.routes.ts` contiene `/quote`, que usa `calculateDirectBookingPricing`, y `/create-checkout`, que vuelve a consultar disponibilidad y precio. El checkout revisado usa un pago de reservación (`mode: payment`); la suscripción recurrente Prime necesita una integración específica.
- `src/pages/public-booking/PublicPropertyDetailPage.tsx`, en la copia del dashboard revisada, consulta `/api/public-booking/quote` y muestra noches, limpieza, amenidades e impuestos. Esos son los puntos de presentación propuestos para el desglose Prime.
- La revisión es de código. No se crearon productos, precios, suscripciones, pagos, reservas ni cambios de checkout en producción.

## Experiencia del anfitrión: propuesta de pantalla

Esta sección concreta el diseño del dashboard del anfitrión. Está confirmado que toda la gestión de Prime para el anfitrión se realiza por propiedad: participación, descuento obligatorio de 5–20% sobre alojamiento, beneficios, membresías referidas y comisiones recurrentes de 40%. La presentación concreta de los controles sigue siendo una propuesta de pantalla.

### Participación y beneficios

Propuesta: añadir «Pin&Go Prime» a la configuración del alojamiento con estos controles:

| Elemento | Comportamiento propuesto |
| --- | --- |
| Participación | Incorporar expresamente el alojamiento a Prime o pausar su participación para nuevas reservas. |
| Descuento Prime | Seleccionar entre 5% y 20%, obligatorio para activar la participación. Mostrar que se aplica únicamente al alojamiento por noche. |
| Otros beneficios | Preparar las opciones adicionales y sus condiciones cuando se definan; no anunciar borradores como beneficios activos. |
| Resumen de condiciones | Mostrar la participación y el descuento guardados, con fecha de actualización. |
| Reservas anteriores | Conservar el precio acordado de las reservas ya confirmadas al cambiar el porcentaje o pausar nuevas ofertas. |

El fundador confirmó que el porcentaje se configura independientemente en cada propiedad. Ejemplo ilustrativo: una propiedad con 5% y otra con 15%. Cada alojamiento conserva su propia configuración e historial; modificar una propiedad no modifica los porcentajes de las demás.

Los canales de compra de membresías ya acordados se mantienen. Registrar una venta desde la página de una propiedad debe conservar esa propiedad y su anfitrión como origen comercial; la participación del alojamiento en el catálogo requiere su configuración explícita de Prime. Una entrada de compra sin propiedad identificada requiere resolver su origen antes de atribuir una comisión a un alojamiento.

### Comisiones de membresías

Propuesta de presentación: una sección «Comisiones Prime» dentro de la propiedad seleccionada en el dashboard del anfitrión. El alcance por propiedad está confirmado:

- Membresías originadas en la página de esa propiedad y cantidad que continúa activa.
- Pagos de membresía y renovaciones efectivamente confirmados de los referidos de esa propiedad, identificando el plan y período correspondiente.
- Comisión correspondiente del 40%, con historial por propiedad y período.
- Importe generado, pendiente de liquidación y efectivamente pagado, según evidencia del sistema.
- Ajustes identificados por separado cuando se definan las políticas de reembolso y disputa.

Esta vista debe calcular comisiones sobre pagos confirmados y registrar cada pago de membresía una sola vez, asociado a su propiedad de origen y conciliado con Stripe Connect. Las consultas y escrituras deben validar que la propiedad seleccionada pertenece al anfitrión autenticado. Una estimación de ingresos futuros no se debe mostrar como dinero cobrado. La base exacta respecto a impuestos y costes de procesamiento y las reglas de redondeo siguen propuestas; la configuración real de pagos de Connect debe verificarse durante la integración.

### Cálculo y registro de comisiones: propuesta

El 40% recurrente y la atribución por propiedad ya están acordados. Se propone calcularlo sobre el importe de membresía efectivamente pagado, excluyendo impuestos y antes de descontar los costes de procesamiento. En esta propuesta, Pin&Go asume dichos costes con su parte; esa distribución de costes requiere validar la decisión comercial. No se están fijando tasas de impuestos ni tarifas del procesador.

Para pagos en USD, se propone redondear la comisión de cada pago al centavo más cercano, con mitades hacia arriba, usando importes decimales exactos o centavos enteros. Con los precios acordados, los ejemplos serían:

| Plan | Base de membresía del pago | Comisión del 40%, redondeada | Importe restante antes de otros costes |
| --- | --- | --- | --- |
| Mensual | USD 9.99 | USD 4.00 | USD 5.99 |
| Anual | USD 89.99 | USD 36.00 | USD 53.99 |

El importe restante no representa ganancia neta: aún debe cubrir procesamiento, tarjeta, empaque, envío y los demás costes que correspondan. Los ejemplos excluyen impuestos y presuponen el pago completo de la membresía. Cualquier descuento futuro sobre el precio de la propia membresía necesitaría sus reglas; el descuento Prime sobre alojamiento es un concepto separado.

La comisión anual se genera una vez por cada anualidad efectivamente pagada; no genera doce comisiones mensuales. La comisión mensual se genera por cada mensualidad pagada. Cada pago confirmado debe iniciar el registro y el reparto correspondiente mediante Stripe Connect. Se distinguen la generación de la comisión, su acreditación en la cuenta conectada y el pago bancario, cuyo calendario depende de la configuración de Stripe y de los fondos disponibles.

### Atribución y movimientos propuestos

La propiedad de origen y su anfitrión se conservan con la membresía. Reservar después otro alojamiento no traslada la atribución. Cambiar entre mensual y anual mantiene ese origen. Una compra directa en pin-ngo.com sin referido verificado no debe atribuirse automáticamente a una propiedad por el hecho de reservarla después. La reactivación después de cancelar la membresía y los cambios de titularidad de la propiedad requieren resolver su política antes de automatizar esos casos.

| Evento | Registro propuesto |
| --- | --- |
| Primer pago o renovación confirmado | Registrar una comisión, vinculada al pago, la membresía, el período, la propiedad de origen y el anfitrión beneficiario. |
| Notificación repetida del mismo pago | Conservar el registro existente; no generar otra comisión ni otro pago al anfitrión. |
| Cambio de plan programado o renovación fallida | No generar comisión hasta que exista un pago confirmado. |
| Cancelación de futuras renovaciones | Conservar las comisiones de pagos anteriores válidos; no generar comisiones por períodos sin pagar. |
| Reembolso confirmado de membresía | Registrar un ajuste sobre la comisión del pago afectado, conservando el historial. |
| Disputa abierta | Identificar y retener la comisión afectada pendiente de liquidación mientras se conoce el resultado; no clasificar toda disputa como pérdida definitiva. |
| Disputa resuelta | Reconciliar el resultado con los ajustes y reembolsos existentes, evitando revertir dos veces el mismo importe. |

Propuesta para reembolsos parciales: recalcular la comisión sobre la base de membresía que queda pagada tras los reembolsos confirmados y registrar la diferencia respecto a la comisión vigente. Ejemplo ilustrativo: una anualidad de USD 89.99 genera USD 36.00; si se reembolsan USD 20.00 del importe de membresía, quedan USD 69.99 y una comisión de USD 28.00; el ajuste es de USD 8.00. Un reembolso total deja la comisión en cero. Esto define un cálculo propuesto cuando exista un reembolso autorizado; no establece por sí solo cuándo el miembro tiene derecho a ese reembolso.

Si la comisión ya fue liquidada, mostrar el ajuste pendiente de resolución. La forma de recuperar esos importes o compensarlos con pagos futuros sigue pendiente de acuerdo e implementación; esta propuesta no autoriza débitos automáticos al anfitrión.

### Liquidación mediante Stripe Connect y presentación al anfitrión

El fundador confirmó que las comisiones se manejan a través de Stripe Connect. El diseño reutiliza la cuenta conectada del anfitrión registrada en su organización y conserva por propiedad la atribución, el cálculo y la conciliación. La integración propuesta combina Stripe Billing para la membresía mensual/anual con Stripe Connect para distribuir la comisión del referido en el primer pago y en las renovaciones confirmadas.

El reparto se automatizará como parte de la integración de Prime. Los identificadores del pago y de las operaciones de Connect deben permitir confirmar importes, destinatario y resultado sin duplicarlos ante reintentos. Si la cuenta conectada no puede recibir fondos, conservar el estado pendiente y mostrar la acción necesaria; registrar una comisión no equivale a haberla abonado.

Por cada propiedad, mostrar comisiones generadas, ajustes, saldo pendiente de liquidación y pagos confirmados, con importe, moneda, período y referencia de origen. Las retenciones y fallos de pago se identifican por separado. La pantalla debe permitir conciliar el saldo: comisiones registradas más ajustes, menos liquidaciones confirmadas, separando cualquier importe retenido.

La atribución se mantiene por propiedad aunque la cuenta de cobro existente sea de la organización. Si una liquidación agrupa varias propiedades, debe conservar su desglose para el anfitrión. La pantalla distingue la acreditación en Connect del pago bancario y refleja el último estado informado por Stripe, incluyendo fallos o correcciones posteriores.

Se conservará la configuración de pagos de la cuenta Stripe Connect; cualquier modificación de ese calendario requiere una decisión específica. Quedan por validar la modalidad de cobro y reparto de Prime, las capacidades de la cuenta para recibir esos fondos, la disponibilidad del saldo y el tratamiento de reembolsos, disputas y comisiones ya pagadas. El uso de Connect no fija por sí solo quién asume las tarifas de procesamiento; la propuesta de que Pin&Go las cubra debe validarse con la modalidad elegida. La verificación de la integración deberá cubrir ambos planes, pagos repetidos, pagos fallidos, atribución por propiedad, reembolsos parciales y totales, disputas y liquidaciones fallidas.

Referencias oficiales revisadas para este diseño: [suscripciones con Stripe Billing y Connect](https://docs.stripe.com/connect/subscriptions) y [calendario de pagos de cuentas conectadas](https://docs.stripe.com/connect/manage-payout-schedule). La documentación distingue la suscripción, la distribución de fondos y el calendario de pagos bancarios. Estas referencias sustentan el diseño; esta actualización no configura productos, suscripciones, transferencias ni pagos en Stripe.

### Base técnica revisada para ubicar estas funciones

- Backend revisado: `af10a9d9191480d6b5b65f902abeb41859ece21a`. `Organization` ya contiene la asociación y el estado de Stripe Connect; `src/routes/dashboard-payouts.routes.ts` obtiene la organización de la sesión autenticada para las consultas de pagos del anfitrión.
- `src/services/stripe-connect.service.ts` revisa la cuenta conectada y su estado para Direct Booking. `src/services/direct-booking-stripe-charge-mode.service.ts` usa cargos directos en la cuenta conectada para las reservas. Prime requiere validar su propia modalidad de suscripción y reparto dentro de Connect; el flujo de reservas existente no incorpora automáticamente la comisión de membresía.
- Esa asociación de pagos existente por organización no cambia el alcance acordado para Prime: configuración, atribución y consulta de comisiones por propiedad. El diseño no implica crear una nueva cuenta de Stripe por cada alojamiento.
- Copia local del dashboard revisada: `701135729c34296e817060dc7fddf7c608fc2ae0`. Existen pantallas de configuración de propiedades, `src/components/payouts/HostPayoutsExperience.tsx` y contratos de estado de pagos en `src/api/payouts.ts`.
- Esta es evidencia de estructura existente. La contabilidad de comisiones recurrentes de Prime y su liquidación todavía requieren una integración específica y validación; la revisión no creó cuentas, transferencias ni cambios en Stripe.

## Evidencia y punto de partida

El piloto NFC autorizó remotamente en Demo una tarjeta registrada previamente en otra propiedad. El proveedor confirmó el alta temporal y la conservación de las tarjetas anteriores. El fundador confirmó por separado apertura física y rechazo después del vencimiento. Esto certifica ese recorrido en el equipo probado, no una integración de membresías en producción ni compatibilidad universal.

Código revisado: backend main `af10a9d9191480d6b5b65f902abeb41859ece21a`.

- `src/routes/public-booking.routes.ts`: consultas por propiedad `/check-availability` y `/quote`; checkout vuelve a comprobar disponibilidad. Deben componerse disponibilidad y precio: cotizar por sí solo no prueba que exista disponibilidad.
- `src/services/availability.service.ts`: servicio existente para validar fechas.
- `src/routes/public-booking.pin-ai.routes.ts`: conversación actual bajo `/manage/:guestToken`, asociada a reserva y su ventana de servicio. Prime requiere una entrada autenticada por miembro antes de reservar; no corresponde ampliar los permisos del token de una estancia para buscar entre organizaciones.
- `src/services/nfc.service.ts`: el inventario actual de tarjetas se organiza por propiedad y por etiquetas de huésped/limpieza. La tarjeta personal Prime requiere una asociación adicional con el miembro y permisos por reserva.
- `PrimeNotifyState` en Prisma es un estado de notificaciones por organización; no representa esta membresía.

## Dashboard del miembro: propuesta de pantallas

Esta sección propone la organización del dashboard a partir de las reglas confirmadas. La navegación, los textos y la presentación siguen sujetos a revisión del fundador; no representan pantallas comerciales implementadas. Ambos planes ofrecen los mismos beneficios y usan el mismo dashboard.

### Navegación y pantalla de inicio

Cuatro secciones principales, con navegación inferior en móvil y lateral en escritorio. La experiencia se presenta en español o inglés según la elección del miembro.

| Sección | Qué encuentra el miembro | Acción principal |
| --- | --- | --- |
| Inicio · Pin AI | Conversación para preparar un viaje, criterios de búsqueda visibles y resultados de propiedades participantes. Si existe una próxima reserva confirmada, un resumen con fechas y acceso a sus detalles. | «Planear mi viaje» o continuar una búsqueda guardada. |
| Mis viajes | Próximas reservas, historial y planes de viaje guardados, identificados por separado. | Ver una reserva o retomar un plan. |
| Mi tarjeta | Estado del envío, tarjeta asociada y estado de acceso para cada estancia. | Consultar entrega, ver el horario de acceso o reportar extravío. |
| Mi cuenta | Perfil, dirección, idioma, plan mensual/anual, vigencia, pagos y gestión de renovación. | Actualizar datos o gestionar la membresía. |

Inicio da prioridad a «Cuéntale a Pin AI cómo quieres tus próximas vacaciones». Ejemplo de texto orientativo, sin representar inventario disponible: «Quiero ir a Puerto Rico con mi pareja, del 6 al 9 de noviembre, cerca de la playa, con piscina privada y hasta USD 800 en total».

La conversación permite expresar todos los requisitos juntos y continuar con cambios naturales. Pin AI pregunta solo por lo que falte o resulte ambiguo, conserva los requisitos durante la conversación y explica por qué encaja cada resultado. Los criterios editables acompañan la conversación. «Cerca de la playa» requiere concretar distancia o forma de desplazamiento cuando sea necesario; piscina privada y piscina compartida se distinguen según evidencia de la propiedad.

Cada resultado muestra el descuento de esa propiedad sobre las noches, el total de la estancia con su desglose y las condiciones de sus beneficios. Para un miembro vigente, el importe de reservar no incluye otra compra de Prime. Si no hay resultados compatibles, se explica qué requisito limita la búsqueda y se ofrecen cambios que el miembro puede elegir. No se presenta una alternativa como coincidencia completa si incumple un requisito obligatorio.

### Mis viajes

- **Próximas e historial:** reservas vinculadas a la identidad verificada del miembro. Mostrar propiedad, fechas en la zona horaria del alojamiento, estado real, importe y beneficios acordados, con enlace al portal de esa reserva.
- **Planes guardados:** conservar por elección del miembro la búsqueda y sus preferencias. Etiqueta visible: «Plan guardado · sin reserva». Al retomarlo, volver a comprobar disponibilidad y precio.
- **Gestión de estancia:** permitir llegar a las funciones existentes del portal mediante acceso verificado. Pin AI para planificar viajes y la asistencia durante una estancia deben respetar sus respectivos alcances y ventanas de servicio.
- **Después de cancelar Prime:** conservar las reservas confirmadas, su precio y el acceso correspondiente, según la regla comercial acordada. La pantalla diferencia el estado de la membresía del estado de cada viaje.

### Mi tarjeta

Presentación propuesta en dos bloques: «Tu tarjeta» para entrega y asociación, y «Acceso en tus viajes» para permisos de cada reservación. La primera tarjeta y su envío aparecen como incluidos; el reemplazo por extravío muestra USD 5 antes de cualquier pago.

El envío muestra únicamente estados respaldados por el proceso real, por ejemplo «En preparación» o «Enviada», y seguimiento si existe. La tarjeta asignada no se presenta como acceso habilitado a todas las propiedades. Cada estancia indica compatibilidad confirmada, horario autorizado y estado real del permiso: programado, confirmado, pendiente de resolución o finalizado, según corresponda. No se muestra «Acceso listo» mientras falte confirmación del sistema de acceso.

«Reportar extravío» y «Solicitar reemplazo · USD 5» son acciones propuestas distintas: el reporte debe permitir iniciar la protección de la tarjeta anterior sin depender de comprar otra. La revocación pendiente se muestra como pendiente hasta tener confirmación. La secuencia de bloqueo, reposición y atención de una estancia en curso sigue pendiente de definición; esta propuesta no la activa ni promete un acceso alternativo aún no validado.

### Mi cuenta y estados del dashboard

Mostrar el plan elegido con su importe y período completos: USD 9.99 al mes o USD 89.99 al año. Mostrar próxima renovación cuando corresponda, o «Beneficios disponibles hasta [fecha]» si la renovación fue cancelada. Incluir recibos, actualización del medio de pago y cancelación de la renovación cuando se implemente el recorrido de suscripción. El cambio entre planes requiere resolver las reglas pendientes antes de habilitar ese control.

Perfil incluye los datos del registro inicial y la dirección de envío. Actualizar la dirección del perfil no debe prometer que se redirige una tarjeta ya despachada; el tratamiento logístico se definirá con el proceso de envío. Idioma y preferencias de viaje se pueden completar después del alta.

| Situación | Presentación propuesta |
| --- | --- |
| Miembro nuevo, sin viajes | Bienvenida y conversación con Pin AI; estado real de preparación de la tarjeta, sin reservas ni beneficios consumidos ficticios. |
| Reserva confirmada próxima | Resumen de la estancia y enlace a sus detalles; acceso físico con sus propias condiciones y horario. |
| Renovación cancelada, período pagado vigente | Beneficios disponibles y fecha de finalización; permitir las operaciones válidas durante ese período. |
| Membresía vencida | Acceso a cuenta, recibos y viajes existentes; invitación a reactivar para obtener beneficios en nuevas reservas. |
| Error al consultar precio, reserva o acceso | Explicar qué dato no se pudo confirmar y permitir reintentar; conservar los criterios y la información introducida. |

Los descuentos de una reserva se muestran a partir del desglose confirmado. La validación futura de estas pantallas debe cubrir móvil y escritorio, ambos idiomas y los estados anteriores.

## Experiencia inicial de búsqueda

Inicio del dashboard: «¿Dónde quieres ir? Cuéntaselo a Pin AI».

Ejemplo ilustrativo, sin alojamientos ni precios inventados:

> Busco una propiedad Prime en Puerto Rico para dos personas del 6 al 9 de noviembre, con piscina y un presupuesto total de 500 dólares.

Pin AI convierte la conversación en criterios visibles y editables: destino, entrada, salida, viajeros, presupuesto total y preferencias. Pide únicamente datos que falten o sean ambiguos. Las fechas relativas se convierten en fechas concretas y se muestran al viajero.

El sistema consulta el catálogo afiliado, valida ocupación/reglas, comprueba disponibilidad y calcula el precio. Pin AI presenta de tres a cinco opciones cuando existan suficientes resultados. Explica el encaje de cada opción con evidencia del alojamiento.

El miembro puede continuar: «solo con piscina privada», «más cerca de la playa», «cambia la salida al lunes» o «quiero usar mi tarjeta Prime». Los criterios y los resultados se actualizan juntos. No se relajan preferencias obligatorias sin indicarlo y recibir la elección del miembro.

Cada tarjeta de resultado contiene:

- Foto, nombre público y ubicación aproximada.
- Fechas, ocupación y precio total en moneda explícita, con desglose de impuestos/cargos obligatorios y descuentos aplicables.
- Beneficios Prime específicos, con sus condiciones.
- Compatibilidad confirmada con la tarjeta física cuando corresponda; la afiliación Prime no implica por sí sola esa compatibilidad.
- Motivo breve de recomendación, «Ver alojamiento», «Comparar» y «Reservar».

Al seleccionar Reservar se vuelven a validar membresía, afiliación, precio, disponibilidad y condiciones antes del checkout existente. La conversación no reserva ni cobra por inferencia. Los requisitos obligatorios de identidad, pago y acceso siguen aplicando.

## Reglas de catálogo y resultados

1. El anfitrión incorpora expresamente cada propiedad a Prime y configura sus beneficios. Estar publicada en Direct Booking no la afilia automáticamente.
2. Una búsqueda Prime ofrece únicamente propiedades afiliadas y habilitadas para la reserva solicitada. Las propiedades de prueba quedan dentro del piloto.
3. La disponibilidad procede del inventario y controles existentes. Si no puede validarse o su actualización no es confiable, el resultado no se presenta como disponible confirmado.
4. Presupuesto «total» incluye los cargos obligatorios calculables. Si falta información para cotizar el total, se solicita o se identifica la cotización como incompleta. Comparar monedas exige una conversión explícita.
5. Pin AI describe tarifas y beneficios devueltos por el sistema. No crea descuentos, comodidades, distancias, políticas ni early check-in/late checkout garantizados.
6. Si no hay coincidencias, explica qué criterio limita la búsqueda y propone alternativas para que el miembro las elija.
7. El resultado es una consulta, no una retención de inventario. Se vuelve a validar al reservar y se muestra cualquier cambio antes de confirmar el pago.
8. Solo el catálogo y los beneficios autorizados se agregan entre organizaciones. La conversación de un miembro no accede a datos privados de otros huéspedes ni de anfitriones.

## Alcance de la primera versión

| Área | Entrega propuesta |
| --- | --- |
| Miembro | Compra, pago confirmado, email de bienvenida, creación de contraseña y registro con dirección de envío. Cuenta persistente, membresía y vínculo verificado con sus reservas. Reutilización de cuenta en Guest como objetivo, previa revisión de su identidad actual. |
| Host | Afiliación y descuento obligatorio de 5–20% sobre alojamiento por noche; comisión recurrente de 40% por membresías originadas en su página, mediante la cuenta Stripe Connect existente. Integración de Prime y conciliación por propiedad pendientes de implementación. |
| Buscar con Pin AI | Conversación en español/inglés, criterios editables, resultados, comparación y selección. |
| Reservar | Reutilizar cotización y checkout de Direct Booking, conservando validaciones. |
| Mis viajes | Próximas estancias, historial y acceso verificado al portal de cada reserva. |
| Mi tarjeta | Asociación miembro–tarjeta y permisos por propiedad/fechas, con estados solicitada, confirmada, fallida, vencida y revocación pendiente/confirmada. |

Primera entrega propuesta: una búsqueda completa en un entorno de prueba con un miembro y propiedades explícitamente habilitadas. El mecanismo NFC se conecta después de validar el vínculo miembro–reserva; no se activa por una búsqueda ni por una cotización.

Voz queda como ampliación posterior de la misma búsqueda. La primera versión usa conversación escrita. Los cambios entre planes, las reglas de liquidación, los destinos y la logística de entrega, y los beneficios adicionales siguen pendientes. Los planes de USD 9.99 al mes y USD 89.99 al año, el descuento obligatorio aplicable desde la misma reserva, la comisión recurrente, la primera tarjeta y su envío incluidos, y el reemplazo por extravío de USD 5 ya están definidos en este documento; su integración con cobros y reservas todavía no está implementada.

## Contrato técnico propuesto

Entrada autenticada por miembro para búsqueda y cotización, independiente de la sesión de una estancia. Nombres de interfaces propuestos, aún no creados:

- `searchPrimeProperties`: recibe criterios estructurados; el servidor impone afiliación, visibilidad, ocupación, estado y alcance del miembro.
- `quotePrimeStay`: devuelve importe, desglose, beneficios aplicables, fechas y evidencia de disponibilidad. Reutiliza los servicios actuales en lugar de repetir el cálculo dentro del modelo.
- Selección de resultado: usa un identificador validado por el servidor y continúa hacia checkout; confirma cambios de precio o condiciones.

Pin AI interpreta y explica. Las funciones del servidor deciden elegibilidad, disponibilidad, precio y permisos. La conversación conserva los criterios y puede continuar entre sesiones del mismo miembro. Las preferencias persistentes requieren una elección del miembro.

## Criterios de aceptación del piloto de búsqueda

- Una propiedad no afiliada o fuera de fechas nunca aparece como opción Prime disponible.
- Se respetan capacidad, restricciones de estancia y requisitos obligatorios.
- Cambiar fechas modifica también disponibilidad, importe y beneficios calculados.
- La respuesta conversacional y las tarjetas muestran el mismo importe y condiciones.
- Ante datos faltantes, resultados vacíos o una consulta fallida, el sistema explica el estado sin inventar ofertas.
- Una reserva concurrente provoca una nueva validación antes del cobro y una respuesta clara al miembro.
- No se emite un acceso NFC desde la búsqueda; una reserva elegible inicia el permiso con las fechas correctas.
- Modificaciones, cancelación y pérdida de tarjeta se reflejan en el permiso con estado real del proveedor; una revocación pendiente no se muestra como completada.

Este documento registra el diseño acordado. El piloto aislado usa conversación contextual, planes de viaje guardados por elección del miembro, disponibilidad y cotización de Demo con la base de datos en modo de solo lectura; su evidencia de verificación está en `prime-pilot/VERIFICATION.md`. El fundador dispone además de una configuración de participación ACTIVE/PAUSED para Demo y beneficios propuestos en borrador. Esto no constituye afiliación comercial de anfitriones ni activa descuentos. El resto de las capacidades propuestas no debe interpretarse como implementado.

El piloto desplegado sigue siendo la versión anterior a esta definición comercial. El trabajo local posterior sobre invitaciones individuales y una condición de pago se pausó para alinear el diseño; no está certificado ni desplegado y no sustituye el alta comercial confirmada. Esta revisión solo actualiza el documento y no incorpora esos cambios locales.
