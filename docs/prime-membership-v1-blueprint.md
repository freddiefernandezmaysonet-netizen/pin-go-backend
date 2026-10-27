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
| Periodicidad | Membresía mensual. |
| Precio | USD 9.99 al mes es el precio probable, pendiente de decisión definitiva. No crear todavía un precio comercial como si estuviera aprobado. |
| Canales de compra | Página de reservas de cualquier anfitrión o directamente en pin-ngo.com. |
| Comisión por captación | El anfitrión desde cuya página se originó la membresía recibe el 40% de cada mensualidad pagada mientras la membresía siga activa. Es una comisión recurrente, no limitada al primer pago. |
| Descuento obligatorio | Para participar en Prime, el anfitrión debe ofrecer un descuento elegido entre 5% y 20%. |
| Base del descuento | Únicamente el precio del alojamiento por noche. El porcentaje no se aplica a limpieza ni a otros cargos. El tratamiento de impuestos pertenece al cálculo de la cotización. |
| Primera tarjeta y envío | Incluidos en la membresía, sin cargo adicional para el miembro. |
| Reemplazo por extravío | USD 5 por reemplazar una tarjeta extraviada. |

La venta de la membresía debe conservar el origen de adquisición y el anfitrión correspondiente para atribuir las mensualidades. La comisión remunera esa adquisición; el descuento beneficia al huésped al reservar alojamiento participante. El documento no define aún las reglas para una suscripción cancelada que se reactiva, los ajustes por reembolsos ni la liquidación de comisiones.

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

## Ciclo de suscripción: propuesta pendiente de decisión

Esta tabla organiza el siguiente punto de diseño. Las reglas de cancelación, renovación fallida y conservación de beneficios en reservas existentes **todavía no han sido aceptadas por el fundador**.

| Situación | Comportamiento propuesto |
| --- | --- |
| Primer pago confirmado | Enviar la bienvenida y permitir completar el registro. |
| Membresía vigente | Mostrar fecha de próxima renovación y beneficios disponibles. Renovación mensual automática, con las condiciones mostradas antes de comprar. |
| El miembro cancela la renovación | Permitir cancelación sin permanencia mínima; conservar beneficios hasta terminar el período ya pagado. Mostrar la fecha exacta de finalización. |
| Falla una renovación | Avisar y permitir actualizar el método de pago. Respetar el período previamente pagado; al vencer, suspender beneficios para nuevas reservas. Reintentos y cualquier período de gracia quedan por definir. |
| La membresía vence | Mantener acceso a cuenta, recibos, viajes existentes y reactivación; restringir nuevos beneficios Prime hasta un nuevo pago confirmado. |
| Ya existen reservaciones confirmadas | Conservar el precio aceptado y el acceso correspondiente a esas estancias, sin cancelarlas ni retirar su acceso por cancelar la renovación de Prime. Cambios posteriores y nuevas reservas requieren sus propias validaciones. |

La propuesta permite distinguir «cancelar la próxima renovación» de «cancelar una reservación». El envío inicial de tarjeta no impone una permanencia mínima no acordada. La comisión del anfitrión sigue vinculada a mensualidades efectivamente pagadas; los ajustes por reembolsos y disputas continúan pendientes.

## Tarjeta personal y envío: alcance del diseño

La tarjeta física personal reutilizable sigue formando parte de Prime y ya existe evidencia de una prueba temporal en Demo. La dirección inicial prepara su envío. El fundador confirmó que **la primera tarjeta y su envío están incluidos en la membresía, sin cargo adicional**. Si el miembro extravía la tarjeta, se cobra **USD 5 por el reemplazo**. Quedan por definir los destinos atendidos y la logística de entrega y reposición. El cargo acordado corresponde a extravío; los casos de defecto, daño o pérdida durante el transporte no están definidos por esta decisión.

El diseño debe distinguir el acceso a la cuenta Prime, el estado del envío y el permiso físico de una estancia. Pagar la membresía permite iniciar el alta acordada; la habilitación de una cerradura requiere además el vínculo verificado entre miembro, tarjeta y reservación. El comportamiento cuando la membresía vence durante una estancia ya pagada sigue pendiente de decisión; la sección de ciclo de suscripción propone conservar esa estancia y su acceso. Este documento no autoriza retirar el acceso a una reservación existente por una regla comercial todavía no acordada.

## Decisiones pendientes, en orden de diseño

1. **Entrega de la tarjeta:** definir destinos cubiertos y logística de entrega. La primera tarjeta y su envío ya están incluidos; el reemplazo por extravío tiene un cargo confirmado de USD 5.
2. **Precio definitivo:** confirmar o ajustar la propuesta de USD 9.99 mensuales.
3. **Suscripción:** cancelación, renovación fallida, recuperación y tratamiento de viajes ya reservados.
4. **Comisiones:** base de liquidación respecto a impuestos/comisiones de procesamiento, calendario de pago, reembolsos, disputas y reactivaciones. El porcentaje recurrente de 40% ya está confirmado.
5. **Descuento:** configuración por propiedad o común al anfitrión; combinación con otras promociones y cambios aplicables a reservas existentes. La obligatoriedad, rango 5–20% y base de alojamiento por noche ya están confirmados.
6. **Tarjeta:** vinculación, recepción, reporte de pérdida, proceso de reposición y tratamiento de permisos pendientes o activos. El precio del reemplazo por extravío ya está definido; quedan pendientes las reglas para defectos, daños o pérdida durante el transporte.

Estas decisiones completan el diseño; no habilitan cobros, comisiones, envío de correos ni cambios de acceso en producción.

## Evidencia y punto de partida

El piloto NFC autorizó remotamente en Demo una tarjeta registrada previamente en otra propiedad. El proveedor confirmó el alta temporal y la conservación de las tarjetas anteriores. El fundador confirmó por separado apertura física y rechazo después del vencimiento. Esto certifica ese recorrido en el equipo probado, no una integración de membresías en producción ni compatibilidad universal.

Código revisado: backend main `af10a9d9191480d6b5b65f902abeb41859ece21a`.

- `src/routes/public-booking.routes.ts`: consultas por propiedad `/check-availability` y `/quote`; checkout vuelve a comprobar disponibilidad. Deben componerse disponibilidad y precio: cotizar por sí solo no prueba que exista disponibilidad.
- `src/services/availability.service.ts`: servicio existente para validar fechas.
- `src/routes/public-booking.pin-ai.routes.ts`: conversación actual bajo `/manage/:guestToken`, asociada a reserva y su ventana de servicio. Prime requiere una entrada autenticada por miembro antes de reservar; no corresponde ampliar los permisos del token de una estancia para buscar entre organizaciones.
- `src/services/nfc.service.ts`: el inventario actual de tarjetas se organiza por propiedad y por etiquetas de huésped/limpieza. La tarjeta personal Prime requiere una asociación adicional con el miembro y permisos por reserva.
- `PrimeNotifyState` en Prisma es un estado de notificaciones por organización; no representa esta membresía.

## Experiencia inicial

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
| Host | Afiliación y descuento obligatorio de 5–20% sobre alojamiento por noche; comisión recurrente de 40% por membresías originadas en su página. Liquidación pendiente de diseño. |
| Buscar con Pin AI | Conversación en español/inglés, criterios editables, resultados, comparación y selección. |
| Reservar | Reutilizar cotización y checkout de Direct Booking, conservando validaciones. |
| Mis viajes | Próximas estancias, historial y acceso verificado al portal de cada reserva. |
| Mi tarjeta | Asociación miembro–tarjeta y permisos por propiedad/fechas, con estados solicitada, confirmada, fallida, vencida y revocación pendiente/confirmada. |

Primera entrega propuesta: una búsqueda completa en un entorno de prueba con un miembro y propiedades explícitamente habilitadas. El mecanismo NFC se conecta después de validar el vínculo miembro–reserva; no se activa por una búsqueda ni por una cotización.

Voz queda como ampliación posterior de la misma búsqueda. La primera versión usa conversación escrita. El precio definitivo de la membresía, las reglas de liquidación, los destinos y la logística de entrega, y los beneficios adicionales siguen pendientes. El descuento obligatorio, la comisión recurrente, la primera tarjeta y su envío incluidos, y el reemplazo por extravío de USD 5 ya están definidos en este documento; su integración con cobros y reservas todavía no está implementada.

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
