# Pin&Go Demo Center: guion y comprobación de una reserva

Objetivo: mostrar cómo Pin&Go coordina una reserva desde su creación hasta el fin de la limpieza, conservando el mismo número `PG-AAAA-NNNNNN`, huésped, propiedad y enlace. El número lo genera el servicio existente; no se reinicia ni se inventa.

## Qué se demuestra

| Paso en pantalla | Acción del presentador | Qué debe verse | Valor para el cliente |
|---|---|---|---|
| 1 · Reserva y registro | Crear una reserva desde Demo Center con los contactos participantes. | Un número PG, fechas, zona de la propiedad y enlace Manage Reservation. Pago e identidad identificados como simulados. | Una reserva inicia la operación. |
| 2 · Comunicaciones | Abrir el correo del huésped y el del administrador principal; mostrar el acuerdo del huésped y abrir Manage Reservation desde el correo. | Ambos correos corresponden al mismo número PG. El correo del huésped incluye el texto y versión del acuerdo guardado para esa reserva, con aceptación expresamente simulada. El portal conserva la estancia y su horario. Mostrar el SMS de acceso y el enlace del cleaner cuando lleguen. | Huésped y equipo reciben la información que necesitan. |
| 3 · Acceso real | Usar el PIN recibido y la tarjeta Guest en la cerradura Demo dentro del horario. | Apertura física y vigencia coincidente con la reserva. El panel muestra el estado registrado y un PIN enmascarado. | Acceso vinculado a la estancia, con inicio y final definidos. |
| 4 · Pin AI | Conversar desde el enlace del huésped. Preguntar por información documentada de la propiedad y horario de la reserva. | Respuestas del modelo en vivo, con el contexto de esa misma reserva; recargar y comprobar que continúa la conversación. | Atención al huésped con contexto, sin buscar manualmente cada dato. |
| 5 · Incidente y respuesta | Reportar un incidente de demostración; el administrador abre el aviso, reconoce el caso, publica una respuesta y lo resuelve. | Una referencia GI, correo al principal y respuesta visible al huésped en Manage Reservation. | El caso llega a una persona responsable y su respuesta regresa al huésped. |
| 6 · Checkout y limpieza | Alcanzar la salida; confirmar disponibilidad, inicio y final de limpieza desde el enlace del cleaner. | PIN y tarjeta Guest vencidos; acceso del cleaner durante su ventana; inicio/final registrados y NFC terminado al vencer. | Continuidad entre salida del huésped y trabajo del equipo. |

## Preparación del presentador

- Utilizar únicamente **Pin&Go Demo Property**, con su cerradura **Demo / TTLock 29944630** y las tarjetas Guest y Cleaning Service correspondientes.
- Entrar como Platform Admin de la organización de esa propiedad. Abrir Demo Center y actualizar Preparación. El correo del principal y el teléfono del cleaner deben coincidir con los participantes disponibles. La demo requiere consentimiento para los SMS del huésped y la invitación del cleaner, incluso fuera de su horario habitual.
- Tener abiertas las bandejas del huésped y del principal, el teléfono del huésped, el enlace del cleaner y el dashboard del host. El cleaner recibe el idioma configurado en su ficha.
- Comprobar que la cerradura y su gateway responden. La comprobación de configuración en Demo Center no certifica conectividad física.
- Elegir entrada y salida en la zona del dispositivo; comprobar la hora y zona de la propiedad en la reserva creada. La pantalla propone entrada en cinco minutos y una estancia de veinte minutos. Puede acortarse la estancia al preparar la demo, sin modificar la configuración global de limpieza.
- La ventana del cleaner conserva la regla existente: `checkout + offset de la propiedad`, hasta **30 minutos**, limitada por la siguiente ocupación. Con entrada +5 min, estancia de 20 min y offset de 15 min, el cierre completo de accesos ocurre aproximadamente a los 70 min desde la creación, más el ciclo del worker. No prometer que toda esa secuencia ocurre en ocho minutos.

La narración siguiente ocupa unos 8–10 minutos, distribuidos durante el recorrido. Para una presentación breve de principio a fin, grabar **una sola ejecución real ya comprobada**, recortar únicamente las esperas y mostrar que es una grabación con sus horas originales. No mezclar reservas ni presentar una grabación como interacción en vivo.

## Guion listo para presentar

**Apertura.** “Pin&Go administra mientras tú ganas libertad. Voy a mostrar una sola reserva y cómo se conectan la comunicación, el acceso, Pin AI y la limpieza. En esta demostración el pago y la identidad están simulados; los mensajes, la conversación y la cerradura se comprueban de verdad.”

**Reserva.** “Aquí comienza todo. Este es el número de reserva y este es el horario de la propiedad. Vamos a seguir este mismo número hasta el final.” Crear una sola vez y señalar el número PG. Si la página tarda o se recarga, usar **Continuar la misma ejecución**.

**Comunicación.** “El huésped recibe su confirmación y su enlace para gestionar la estancia. El administrador principal recibe el aviso de la misma reserva.” Abrir ambos correos y seguir el enlace real del huésped. “Aceptado por el proveedor” y “Entregado” son estados distintos; abrir el correo/SMS recibido es la comprobación visible.

**Acceso.** “El acceso corresponde al horario de esta estancia.” Mostrar el SMS/correo de acceso y abrir la cerradura Demo. Probar la tarjeta Guest. No leer en voz alta ni proyectar credenciales de otras reservas.

**Pin AI.** Escribir: “¿Cuál es el horario de salida de mi reserva?” y “¿Qué información tienes sobre el estacionamiento de esta propiedad?”. Usar solo información realmente documentada. “Pin AI responde con el contexto de la estancia. Cuando algo requiere al anfitrión, puede quedar registrado para que se atienda.”

**Incidente.** Avisar al público que es un reporte de demostración y escribir: “No sale agua caliente”. Seguir las preguntas del agente, sin inventar que hubo una avería física. Abrir la referencia GI desde el correo o Demo Center. Reconocerla y publicar: “Recibimos tu reporte. El equipo revisará el agua caliente; te avisaremos por este mismo medio.” Volver al portal y mostrar la respuesta. Resolver con una nota que indique que el caso era una demostración. Resolver un caso en pantalla no prueba una reparación física.

**Salida y limpieza.** “Al llegar la salida, termina el acceso del huésped. La limpieza continúa con el equipo asignado.” Mostrar el mensaje de checkout y probar que el PIN/tarjeta Guest ya no abren. Desde el enlace del cleaner, confirmar disponibilidad con antelación, aceptar las condiciones de seguimiento, confirmar inicio y final cuando corresponda. Probar la tarjeta Cleaning Service dentro de su ventana y después de su vencimiento. Las declaraciones de inicio/final son acciones del cleaner; no se presentan como lecturas físicas de NFC.

**Cierre.** “Esta fue una sola reserva: comunicaciones, acceso temporal, asistencia al huésped, respuesta del anfitrión y limpieza. Pin&Go conecta esas tareas para reducir el seguimiento manual.” Mostrar el mismo número PG y los estados finales. **Preparar siguiente demo** debe habilitarse cuando terminó la estancia, se registró la limpieza completa y los accesos registrados quedaron cerrados.

## Si una etapa se interrumpe

- Recargar o usar **Actualizar estado**. Mantener la misma ejecución; no crear otra reserva para tapar un fallo.
- **Continuar la misma ejecución** retoma lo pendiente y conserva número/token. Las confirmaciones con aceptación registrada no se envían de nuevo.
- Si el envío quedó incierto, la pantalla pide revisión. No reenvía a ciegas: hay que contrastar MessageLog y el proveedor antes de decidir una reparación. No interpretar ese estado como entrega.
- Si cambió un destinatario antes de crear, el formulario vuelve a permitir corregir la preparación. Si ya existe reserva, conserva sus datos y exige continuar esa misma ejecución.
- Si el horario terminó antes de completar una etapa, no extender reservas ni editar la base de datos para aparentar éxito. Revisar la ejecución Demo y cerrar sus accesos de forma controlada antes de otra presentación.
- No cancelar, reparar ni reutilizar `PG-2026-000062` como parte de esta implementación. No modificar reservas comerciales, reglas globales de limpieza, Stripe o distribución Channex.

## Criterio de aceptación operativa

Registrar en una sola ficha: número PG y requestId, commit desplegado en API/worker/dashboard, hora y zona de cada paso, referencia GI y evidencias redactadas. No guardar tokens, PIN completos ni contactos personales en un PR público.

La demo se considera comprobada solamente cuando esa ficha contiene:

1. Correo recibido por huésped y principal, enlaces correctos y el mismo PG en ambos. En el del huésped se ve el acuerdo guardado, su versión y la indicación de aceptación simulada. Un correo ya enviado no cambia; comprobar esta incorporación en la siguiente ejecución, sin reenviar para ocultar fallos.
2. Manage Reservation accesible con los horarios correctos y sin cobros/cambios comerciales.
3. Mensaje de acceso recibido; apertura real del PIN y tarjeta Guest dentro de su ventana, y rechazo después de checkout.
4. Conversación real de Pin AI conservada al recargar, con contexto correcto de la reserva.
5. Incidente registrado una sola vez, aviso al principal, reconocimiento y respuesta publicada visibles al huésped, resolución coherente.
6. Checkout y limpieza: disponibilidad, inicio, final; acceso Cleaning Service válido solo en su ventana y vencido al final. Una segunda ejecución usa un PG nuevo sin alterar la anterior ni duplicar sus comunicaciones.

CI, un proveedor que devuelve “aceptado”, una asignación marcada ACTIVE o Railway verde no sustituyen estas comprobaciones.

## Alcance técnico cerrado

La implementación conecta servicios existentes mediante un coordinador acotado a Demo. No crea un producto separado, no restaura Lodgify, no agrega migraciones de producción y no habilita acciones financieras de Pin AI. Las canaries comerciales existentes siguen su política; la autorización adicional de incidentes solo se deriva de una reserva Demo canónica de la organización correcta.

La regla acordada para **nuevos accesos de huésped**, incluida Demo, es:

| Cerradura | PIN | Vigencia |
| --- | --- | --- |
| Sin gateway asociado, confirmado por TTLock | Timed aleatorio, por el flujo existente | Ventana de la reserva, con las restricciones de TTLock para Timed |
| Con gateway asociado | Custom con los últimos cuatro dígitos del teléfono, conservando ceros iniciales | Check-in a checkout; no es permanente |
| Con gateway, sin teléfono válido o con PIN ocupado | Custom aleatorio de ocho dígitos | La misma ventana |

Un gateway conocido pero desconectado no se sustituye por Timed. Solo una respuesta válida de creación, o la conciliación exacta de un intento anterior, permite activar y comunicar el acceso. Un fallo incierto conserva el candidato cifrado y requiere conciliación; no genera otro PIN ni elimina códigos ajenos. La selección se serializa por cerradura. Los accesos ya emitidos conservan su código y vigencia; no hay migración ni recodificación masiva. Un PIN revocado puede reutilizarse solo si ya no aparece en TTLock ni está reservado por otro acceso pendiente/activo.

Demo requiere gateway para respetar sus minutos exactos. Referencias del proveedor: [PIN aleatorio](https://euopen.ttlock.com/documentPages/htmlPages/cloud/passcode/getEn.html), [Custom por gateway](https://euopen.ttlock.com/documentPages/htmlPages/cloud/passcode/addEn.html) e [inventario de PIN](https://euopen.ttlock.com/doc/api/v3/lock/listKeyboardPwd).

Frase para la presentación: «El huésped recibe un acceso fácil de recordar y válido únicamente durante su estancia. Pin&Go coordina la cerradura, la reserva y los mensajes; después del checkout comienza la ventana independiente de limpieza». No afirmar que el PIN de cuatro dígitos abre la cerradura física hasta comprobarlo en la siguiente ejecución controlada. La apertura previa con Custom aleatorio no certifica esta nueva política.

## Evidencia automatizada

Prueba principal: `src/services/internal-demo-commercial.db.test.ts`, workflow **Demo Center Direct Booking parity**. PostgreSQL 16 desechable, migraciones reales, rutas HTTP reales, servicios reales y transportes controlados de correo, SMS, TTLock y OpenAI. Cubre autorización, recuperación tras aceptación de correo, concurrencia/reintentos, PG/token estables, entregas e incertidumbre, portal, bloqueo comercial, acceso temporal, conversación/continuidad, incidente/respuesta y limpieza/revocación; repite horarios nocturnos y cruce de medianoche. Conserva intacta una reserva comercial centinela.

La misma prueba comprueba la política de nuevos accesos en reservas comerciales sintéticas: ceros iniciales, conflicto entre reservas, concurrencia, cifrado y ocultación, recuperación de respuesta perdida sin una segunda creación, gateway desconectado, Timed sin gateway y eliminación exclusiva del PIN propio. `guest-passcode-provision.service.test.ts` añade errores de proveedor, inventario incompleto, límites de reintento y rechazo de conciliaciones con otra ventana o reserva.

El mismo workflow reproduce el rechazo del validador desplegado en `66cdf20` y prueba la corrección sobre una reserva creada por ingest nativo. El dashboard añade **Demo Center commercial journey UI**, con pantallas React reales, respuestas sintéticas de API y capturas de escritorio/móvil. Ninguna de estas pruebas utiliza contactos, credenciales o dispositivos de producción.

Orden de salida: revisar pruebas y capturas → aprobar merge/despliegue → verificar SHA efectivo y preparación en API/worker/dashboard → una ejecución operativa controlada con la ficha anterior. No pedir al operador que repita pruebas en producción para descubrir problemas que se pueden reproducir en estos entornos.
