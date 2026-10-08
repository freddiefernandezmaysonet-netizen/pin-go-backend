# Mis limpiezas — preparación histórica de PR Draft

Los PR ya están abiertos: Backend #376 y Dashboard #198. Estado actual y enlaces en `my-cleanings-continuity.md`. Las descripciones siguientes registran la preparación previa.

Publicar únicamente las ramas `agent/cleaner-account-access-v1`. Destinos: `freddiefernandezmaysonet-netizen/pin-go-backend` y `freddiefernandezmaysonet-netizen/pin-go-dashboard`. Base: `main`. No habilitar auto-merge ni hacer merge o despliegue de producción.

La publicación fue bloqueada por revisión automática el 7 de octubre de 2026 por falta de autorización explícita para estos destinos. Se comprobó después que ninguna de las dos ramas existe en GitHub. La autorización explícita se recibió después. El siguiente intento de push falló por ausencia de credenciales de terminal; se usa el conector autorizado de GitHub.

## Backend

Título: `Mis limpiezas: tareas propias, ventanas, checklist y recuperación acotada`

Descripción preparada:

El cleaner obtiene acceso exclusivo a sus tareas y puede confirmar, iniciar y finalizar con controles de identidad y horario en el servidor. La cancelación antes del inicio ofrece el siguiente respaldo viable con aceptación explícita y tarjeta propia. El checklist se configura por propiedad y cada limpieza conserva una copia fija y su progreso.

El trabajo y el acceso tienen ciclos independientes: finalizar no revoca acceso y vencer acceso nunca completa la limpieza. La duración comprometida usada en early check-in y late checkout permanece separada de la ventana de acceso. Se conservan las ofertas y recordatorios existentes; se retiran SMS rutinarios redundantes y sus reintentos.

Los reportes de retraso, más tiempo y trabajo incompleto se evalúan con límites por propiedad. La extensión requiere inicio explícito, acceso ACTIVE estable, evidencia exacta de programación, ningún próximo check-in y el límite vigente del host. Las respuestas físicas ambiguas no se repiten a ciegas. La recuperación recorre todos los lotes desde reportes persistidos; un fallo no impide las tareas posteriores y una nueva ejecución redescubre el trabajo fallido.

Validación: 147 pruebas Backend en los grupos documentados, TypeScript del cleaner y SQL aislado en PGlite. Las otras tres pruebas de interacción React y la compilación corresponden al Dashboard compañero. No se certificó concurrencia PostgreSQL nativa ni NFC física. Migraciones y reglas detalladas: `docs/my-cleanings-review-20261007.md`. Estado cronológico: `docs/my-cleanings-release-tracker.md`.

Mantener Draft hasta revisar compatibilidad con main, controles actuales de Pin AI, migraciones en certificación, concurrencia nativa, revisión móvil y tarjeta real. La extensión automática de un acceso ya ENDED no está implementada. Enlazar aquí el PR del Dashboard al crearlo.

## Dashboard

Título: `Mis limpiezas: vista del cleaner y configuración por propiedad`

Descripción preparada:

Añade la página exclusiva del cleaner en su idioma con Hoy, Próximas e Historial, paginación por vista, horarios de trabajo y acceso diferenciados, acciones de inicio/finalización y cancelación previa a la ventana. Los botones se actualizan con el reloj y se vuelven a validar al enviar la acción.

Incluye checklist de la tarea, reportes de retraso/más tiempo/trabajo incompleto y estados de recuperación que distinguen una propuesta de una extensión confirmada. El host configura la plantilla del checklist y los límites de recuperación por propiedad con protección contra ediciones concurrentes.

Validación: tres pruebas de interacción React, TypeScript focalizado y build Vite aprobados. Pendiente revisión visual en navegador móvil y certificación conjunta con API y tarjeta real. Depende del PR Backend y sus migraciones. Mantener Draft; no fusionar independientemente. Enlazar aquí el PR Backend al crearlo.

## Continuidad

Commits locales de referencia: Backend `5fd255b8`, Dashboard `691ddd2`. La terminal no dispone de credenciales de push: publicar los árboles exactos mediante el conector GitHub como commits consolidados. Conservar el historial original en `docs/my-cleanings-local-history.md`; no reconstruir ni sustituir el código desde el ZIP anterior. Tras crear ambos PR, registrar sus enlaces y SHA remotos aquí y en sus descripciones, consultar checks y conservar la lista cerrada de certificación. No ampliar alcance.
