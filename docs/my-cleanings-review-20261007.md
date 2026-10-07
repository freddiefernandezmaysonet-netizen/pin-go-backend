# Mis limpiezas — entrega para revisión

Fecha: 7 de octubre de 2026. Estado: implementación local revisable; pendiente de certificación en el entorno de destino. Publicada en PR Draft Backend #376 y Dashboard #198, sin merge ni despliegue de producción. Consultar `my-cleanings-continuity.md` para los commits remotos.

## Alcance cerrado

Conservar la asignación principal/respaldo, aceptación por texto, tarjetas propias y programación existente. Completar el Dashboard y las recuperaciones acordadas. No rediseñar Twilio ni añadir familias de mensajes al cleaner.

## Flujo acordado

| Paso | Comportamiento |
| --- | --- |
| Oferta | El principal recibe la oferta existente y acepta explícitamente. Si rechaza, pasa al respaldo en el orden configurado. La tarea aceptada aparece en su Dashboard. |
| Dashboard | Solo tareas del cleaner autenticado: Hoy, Próximas e Historial, en español o inglés según su preferencia. La paginación aplica después de filtrar la vista. |
| NFC | La tarjeta propia queda SCHEDULED. El worker la programa desde dos horas antes del inicio con las fechas correctas; la entrada física solo corresponde al período programado. El respaldo sigue esas mismas reglas. |
| Cancelación | Permitida antes del inicio de la ventana canónica. Desde ese inicio queda bloqueada aunque el cleaner no haya pulsado Empezar. Una cancelación válida invalida la programación aún no intentada y ofrece al siguiente respaldo viable. Una tarjeta ya programada conserva su período original; no se considera permiso para trabajo nuevo. |
| Empezar | Exige aceptación y consentimiento de horario. El servidor vuelve a comprobar el inicio inclusivo y cierre exclusivo al recibir la acción. La página actualiza sus botones con el reloj. |
| Checklist | Plantilla editable por el host en cada propiedad. La tarea guarda una copia fija. La reasignación conserva ese checklist y su progreso; una edición posterior del host afecta tareas posteriores. |
| Terminar | Exige inicio explícito y los puntos obligatorios completos. Una próxima llegada limita el cierre. Sin próximo check-in, una tarea iniciada puede registrar la finalización después de vencer el acceso. |
| Acceso | Los botones no activan, prolongan ni revocan el acceso. Terminar registra el trabajo y conserva el acceso restante. Vencer acceso nunca completa el trabajo. |
| Recordatorio de inicio | Se conserva en el inicio programado más la tolerancia configurada, si falta la marca de inicio. |
| Recordatorio de finalización | Se conserva en el inicio programado más la duración comprometida, si falta la marca de finalización. No se mueve por un inicio tardío. |
| Reportes | Llegaré tarde antes de iniciar; necesito más tiempo o no puedo completar después de iniciar. Guardar un reporte no significa resolverlo, completar ni conceder acceso. |
| Pin AI | Evalúa el reporte con los límites actuales de la propiedad. Sigue estimaciones viables; puede extender un acceso ACTIVE con evidencia exacta, inicio explícito, límite autorizado y ningún próximo check-in. La duración comprometida para early check-in/late checkout permanece intacta. |
| Recuperación incompleta | Ofrece un respaldo viable, que debe aceptar explícitamente. Programa la tarjeta propia de ese respaldo; no hereda la extensión del cleaner anterior. Si no hay cobertura viable, escala al host. |
| Horas de mensajes | Se conserva 08:00–18:00 en la zona horaria de la propiedad, incluidos fines de semana. Una oferta urgente que no puede esperar genera atención del host; no ignora silenciosamente ese horario. |
| Mensajes | Se conservan oferta/aceptación y recordatorios condicionados. Se retiraron los SMS rutinarios de listo, NFC activo y acceso finalizado. Se impide reintentar esos mensajes retirados. |

Los límites existen para todas las propiedades actuales y futuras, sin lista de propiedades piloto. En ausencia de configuración: retraso 30 minutos, extensión 0 minutos y margen de llegada 0 minutos. Cero extensión no autoriza tiempo adicional.

## Corrección final de recuperaciones

Se eliminó el cursor compartido en memoria. Cada ejecución recorre por páginas las tareas con reportes persistidos, con un cursor propio de esa ejecución. Un error individual permite continuar con las tareas posteriores. Una nueva ejecución vuelve a descubrir las tareas desde la base de datos, incluso si la ejecución anterior se interrumpió.

Esto garantiza que el recorrido no omita indefinidamente una tarea por haber avanzado un cursor volátil. No es una promesa de ejecución exactamente una vez: los comandos físicos conservan su intención persistida y sus controles de idempotencia. Una respuesta física ambigua se registra como UNCERTAIN y exige revisión; nunca se repite a ciegas.

Pruebas nuevas: 61 tareas cruzando tres páginas, fallos al principio y en otra página, continuación posterior, nueva ejecución, interrupción de consulta, recorridos independientes y tamaños inválidos. También se verifica con SQL que el reporte fallido permanece y vuelve a encontrarse en una nueva ejecución.

## Validación de esta entrega

- 59 pruebas de políticas, ventanas, evaluación, recuperación, lotes y recordatorios.
- 45 pruebas de autorización/API, reportes, configuración, avisos y recibos.
- 10 pruebas de recuperación con SQL y proveedor físico sustituido por un simulador.
- 23 pruebas de SQL de reasignación, ventanas, checklist y vistas/paginación.
- 10 pruebas de formato y costos de mensajes existentes.
- 3 pruebas de interacción React: página del cleaner, checklist del host y límites del host.
- TypeScript del backend y la página del cleaner; compilación del Dashboard.

Total: 150 pruebas aprobadas en estos grupos. Dos expectativas antiguas de formato bilingüe se actualizaron al idioma predeterminado actual; no se modificó el formatter ni se restauró ningún envío.

Los grupos SQL se ejecutaron por separado en bases PGlite descartables. Un intento inicial de agruparlos falló por colisión de prepared statements del adaptador compartido y por incluir una prueba con otro esquema aislado; no se alteró código de negocio para ocultar esos fallos. Las 23 pruebas pertinentes y el grupo de recuperación pasaron después, cada uno en su entorno compatible. PGlite no certifica concurrencia de PostgreSQL nativo.

## Lo que falta para publicar

1. Revisar este flujo y el diff consolidado. La integración con los main indicados y los controles actuales de Pin AI está verificada localmente; consultar `my-cleanings-continuity.md`. Cambios posteriores en main requieren nueva revisión.
2. Aplicar y comprobar migraciones en el entorno de certificación autorizado, con PostgreSQL nativo. Probar sesiones concurrentes: cancelar/programar, extensión/vencimiento y cambio de política/llegada durante una recuperación.
3. Revisar visualmente en móvil y ejecutar una limpieza de certificación con tarjeta real: aceptación, programación anticipada, entrada dentro del período, botones, finalización y cierre de acceso. La variante respaldo debe comprobar su propia tarjeta.
4. Solo después, autorizar incorporación y publicación controlada con posibilidad de volver a la versión previa.

No se puede marcar como terminada la certificación física con un proveedor simulado. En este entorno no está disponible un navegador ejecutable para certificar la revisión visual móvil. La extensión de acceso ya ENDED no está implementada como reapertura automática: se deriva a revisión; el flujo automático probado requiere un grant ACTIVE estable.

## Migraciones de la rama

Aplicar en su orden, además de las migraciones base de la rama destino:

- 20261006220000_cleaner_account_access_v1
- 20261006230000_cleaning_checklist_v1
- 20261007090000_cleaner_nfc_programming_attempts
- 20261007190000_cleaning_work_issue_reports
- 20261007193000_cleaning_recovery_policy
- 20261007200000_cleaning_access_extension

## Estado de repositorios

Backend: rama `agent/cleaner-account-access-v1`, implementación consolidada en `be0c501e` más la corrección final del recorrido y pruebas de esta entrega. Dashboard: misma rama, implementación consolidada en `691ddd2`; no se modificó su funcionalidad en esta corrección final. El ZIP previo es un respaldo anterior y no sustituye estos commits y cambios posteriores.
