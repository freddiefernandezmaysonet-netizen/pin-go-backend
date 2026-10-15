/** Public commercial summaries reviewed against the audit source commit.
 * Evidence paths remain server-side; conditions are required in every answer. */
export const salesVoiceDetailedKnowledge = [
  {
    "id": "platform_apms",
    "titleEs": "Qué es el APMS",
    "titleEn": "What the APMS does",
    "es": "Pin&Go reúne reservas, distribución, acceso, limpieza, comunicaciones y seguimiento operativo para administrar alojamientos y propiedades vacacionales.",
    "en": "Pin&Go brings together reservations, distribution, access, cleaning, communications and operational monitoring for vacation rental management.",
    "limit": "La automatización depende de los módulos habilitados, datos y equipos configurados. No prometas eliminar toda intervención humana ni garantizar ingresos.",
    "sources": [
      "src/apms/engine-catalog.ts",
      "src/server.ts"
    ]
  },
  {
    "id": "property_configuration",
    "titleEs": "Configuración de propiedades",
    "titleEn": "Property setup",
    "es": "Cada propiedad puede tener información de publicación, fotos, capacidad, amenidades, cargos, impuestos, reglas y horarios de entrada y salida. Esa configuración alimenta las reservas directas y las respuestas relacionadas con la propiedad.",
    "en": "Each property can have listing information, photos, capacity, amenities, fees, taxes, rules and check-in/check-out times. This configuration feeds direct booking and property-related answers.",
    "limit": "No existe un horario universal para todas las propiedades. La información debe completarse y revisarse por propiedad; este agente no consulta datos privados.",
    "sources": [
      "src/services/property-listing-details.service.ts",
      "src/routes/dashboard.properties.route.ts"
    ]
  },
  {
    "id": "host_calendar_restrictions",
    "titleEs": "Calendario y restricciones",
    "titleEn": "Calendar and restrictions",
    "es": "El calendario del anfitrión reúne reservas, bloqueos, tarifas y restricciones por fecha. Las reglas de disponibilidad y duración de estadía se aplican según la configuración; las tarifas pueden tener ajustes manuales.",
    "en": "The host calendar brings together reservations, blocks, rates and date restrictions. Availability and stay-length rules follow configuration, and rates may have manual adjustments.",
    "limit": "No asegures que editar una restricción desbloquea fechas bloqueadas en una OTA. La sincronización depende del canal y de la conexión; no consultes disponibilidad concreta por teléfono.",
    "sources": [
      "src/services/host-calendar.service.ts",
      "src/services/direct-booking-pricing.service.ts",
      "src/routes/dashboard.calendar-overrides.route.ts"
    ]
  },
  {
    "id": "guest_portal",
    "titleEs": "Portal de la reserva",
    "titleEn": "Guest reservation portal",
    "es": "El huésped puede acceder al portal de su reserva mediante su enlace para consultar información y las acciones de gestión disponibles, incluidas vistas de cancelación y propuestas de cambios cuando corresponda.",
    "en": "Guests can use their reservation link to view reservation information and available management actions, including cancellation previews and eligible change proposals.",
    "limit": "El enlace es privado. Las acciones dependen del estado, origen y políticas de la reserva; no pidas el enlace ni afirmes haber cambiado una reserva durante una llamada comercial.",
    "sources": [
      "src/routes/public-booking.routes.ts"
    ]
  },
  {
    "id": "cancellation_refunds",
    "titleEs": "Cancelaciones y reembolsos",
    "titleEn": "Cancellations and refunds",
    "es": "Las propiedades pueden configurar políticas de cancelación con plazos, porcentajes y base de cálculo. El portal puede mostrar la cancelación y el reembolso que corresponden a la política aplicable; hay procesamiento mediante Stripe para los casos elegibles.",
    "en": "Properties can configure cancellation policies with timing tiers, percentages and calculation bases. The portal can preview the applicable cancellation and refund, with Stripe processing for eligible cases.",
    "limit": "No garantices un porcentaje, reembolso total, devolución de limpieza o plazo bancario. La elegibilidad, el origen de la reserva y la configuración deben verificarse.",
    "sources": [
      "src/services/cancellation-policy.service.ts",
      "src/services/guest-cancellation.service.ts"
    ]
  },
  {
    "id": "stripe_connect",
    "titleEs": "Cobros y pagos al anfitrión",
    "titleEn": "Host payments and payouts",
    "es": "Stripe Connect permite configurar la cuenta de pagos de la organización, completar el onboarding financiero y consultar su estado y transacciones. Las reservas directas usan el flujo de pago configurado.",
    "en": "Stripe Connect supports an organization payment account, financial onboarding, account status and transactions. Direct bookings use the configured payment flow.",
    "limit": "La cuenta debe cumplir requisitos de Stripe. No prometas liquidación inmediata, disponibilidad en todos los países, tarifas bancarias ni un tipo de responsabilidad contractual sin confirmación.",
    "sources": [
      "src/services/stripe-connect.service.ts",
      "src/routes/dashboard-payouts.routes.ts"
    ]
  },
  {
    "id": "guest_identity",
    "titleEs": "Identidad y acceso del huésped",
    "titleEn": "Guest identity and access",
    "es": "La verificación de identidad puede configurarse para reservas directas junto con condiciones de acceso y aceptación del huésped. No debe presentarse como un requisito general de todas las reservas de canales externos.",
    "en": "Identity verification can be configured for direct bookings together with guest access conditions and consent. It must not be described as a blanket requirement for external-channel reservations.",
    "limit": "Depende del origen de la reserva y de las opciones de la propiedad. Los cargos requieren condiciones y consentimiento; no solicites documentos por teléfono.",
    "sources": [
      "src/services/guest-identity-verification.service.ts",
      "src/routes/dashboard.guest-access-settings.routes.ts",
      "src/services/identity-check-billing-consent.ts"
    ]
  },
  {
    "id": "property_protection",
    "titleEs": "Protección de la propiedad y daños",
    "titleEn": "Property protection and damage cases",
    "es": "Pin&Go incluye un flujo para registrar casos de daños, presentar evidencia, revisarlos y gestionar una autorización de pago o cobro elegible.",
    "en": "Pin&Go includes a workflow to record damage cases, submit evidence, review them and manage an eligible payment authorization or charge.",
    "limit": "No es una garantía de seguro ni un cobro automático por cualquier reclamación. Requiere consentimiento o autorización válida, revisión, elegibilidad y la configuración correspondiente.",
    "sources": [
      "src/routes/dashboard.damage-cases.routes.ts",
      "src/services/damage-case-payment-execution.service.ts"
    ]
  },
  {
    "id": "early_late",
    "titleEs": "Entrada temprana y salida tardía",
    "titleEn": "Early check-in and late checkout",
    "es": "Pin AI y los flujos de estadía pueden evaluar entrada temprana o salida tardía usando horarios, limpieza y disponibilidad. Los casos elegibles pueden generar una propuesta y un pago antes de aplicar el cambio.",
    "en": "Pin AI and stay workflows can evaluate early check-in or late checkout using schedules, cleaning and availability. Eligible cases may generate a proposal and payment before applying a change.",
    "limit": "No se concede siempre ni tiene un precio fijo. Requiere políticas y funciones habilitadas, consentimiento, pago si aplica y confirmación del cambio; una cotización no modifica el acceso.",
    "sources": [
      "src/services/stay-time-guest-action.service.ts",
      "src/services/stay-time-quote.service.ts",
      "src/services/property-stay-time-settings.service.ts"
    ]
  },
  {
    "id": "reservation_changes",
    "titleEs": "Extensiones y cambios de fechas",
    "titleEn": "Extensions and date changes",
    "es": "El backend contempla vistas previas de extensiones y cambios de reserva, verificación de disponibilidad y precio, confirmación y checkout de la diferencia cuando corresponde.",
    "en": "The backend supports reservation extension and change previews, availability and price checks, confirmation and checkout for an applicable difference.",
    "limit": "El origen de la reserva, la ventana de solicitud, el estado y las funciones habilitadas limitan los cambios. No prometas modificar automáticamente cualquier reserva OTA; una estimación no es aprobación ni pago.",
    "sources": [
      "src/services/guest-reservation-modification.service.ts",
      "src/services/guest-reservation-modification-checkout.service.ts",
      "src/pin-ai/guest/reservation-change-commercial-policy.ts"
    ]
  },
  {
    "id": "cleaner_workflow",
    "titleEs": "Mis limpiezas y checklist",
    "titleEn": "Cleaner work and checklists",
    "es": "El personal puede consultar sus limpiezas, confirmar disponibilidad, registrar inicio y finalización y completar listas de tareas. La experiencia contempla idioma del personal y reportes relacionados con el trabajo.",
    "en": "Staff can view their cleanings, confirm availability, record start and completion and complete checklists. The experience supports staff language preferences and work-related reports.",
    "limit": "Requiere cuenta, asignación y reglas por propiedad. Aceptar la limpieza o tener acceso no demuestra que el trabajo se haya terminado.",
    "sources": [
      "src/routes/cleaner-account.routes.ts",
      "src/routes/cleaning-confirm.routes.ts",
      "src/services/cleaning-checklist.service.ts"
    ]
  },
  {
    "id": "cleaner_backup_access",
    "titleEs": "Respaldos y acceso de limpieza",
    "titleEn": "Cleaning backups and access",
    "es": "La coordinación de limpieza contempla personal principal y respaldos. Los rechazos o cancelaciones elegibles pueden ofrecer el trabajo al siguiente respaldo, con permisos de acceso vinculados a la asignación y su horario.",
    "en": "Cleaning coordination supports primary staff and backups. Eligible declines or cancellations can offer work to the next backup, with access tied to the assignment and schedule.",
    "limit": "Se debe configurar el personal y la política. No prometas reemplazo confirmado, acceso ilimitado ni cancelación libre después de iniciada la ventana de trabajo.",
    "sources": [
      "src/services/cleaning-reassignment.service.ts",
      "src/routes/staff.routes.ts",
      "src/services/cleaner-access-extension.service.ts"
    ]
  },
  {
    "id": "guest_communications",
    "titleEs": "Mensajes y notificaciones",
    "titleEn": "Guest communications",
    "es": "Pin&Go contempla comunicaciones relacionadas con reservas, pagos, acceso y limpieza, con correo o SMS según el flujo, los datos del destinatario y la configuración.",
    "en": "Pin&Go supports reservation, payment, access and cleaning communications by email or SMS according to the workflow, recipient data and configuration.",
    "limit": "No todos los mensajes usan todos los canales. Dependen del consentimiento, datos disponibles y proveedor; un envío aceptado no confirma lectura ni resolución.",
    "sources": [
      "src/services/preCheckinSms.service.ts",
      "src/routes/dashboard.messages.routes.ts",
      "src/routes/message-delivery.webhooks.routes.ts"
    ]
  },
  {
    "id": "ota_messaging",
    "titleEs": "Bandeja de mensajes de canales",
    "titleEn": "Channel messaging inbox",
    "es": "La bandeja del anfitrión contempla conversaciones y mensajes de canales integrados mediante Channex, envío de respuestas y controles o borradores de Pin AI cuando están habilitados.",
    "en": "The host inbox supports conversations and messages from channels integrated through Channex, sending replies and enabled Pin AI controls or drafts.",
    "limit": "Requiere la integración y permisos de mensajería de cada canal y propiedad. No prometas mensajería ni datos de contacto completos en todas las OTA.",
    "sources": [
      "src/routes/dashboard.channex-host-inbox.route.ts",
      "src/routes/channex-messages.webhook.route.ts"
    ]
  },
  {
    "id": "property_knowledge",
    "titleEs": "Información que usa Pin AI",
    "titleEn": "Information used by Pin AI",
    "es": "El anfitrión puede mantener conocimiento de la propiedad en español e inglés, organizado por categorías y con reglas de visibilidad. Pin AI combina conocimiento permitido con contexto autorizado de la reserva.",
    "en": "Hosts can maintain Spanish and English property knowledge, organized by category with visibility rules. Pin AI combines permitted knowledge with authorized reservation context.",
    "limit": "El contenido debe ser correcto y estar actualizado. Las notas internas no deben convertirse en información pública; este agente de ventas no lee conocimientos privados de propiedades.",
    "sources": [
      "src/routes/dashboard.property-knowledge.routes.ts",
      "src/pin-ai/property-knowledge-entry.contract.ts",
      "src/pin-ai/property-knowledge.service.ts"
    ]
  },
  {
    "id": "guest_incidents",
    "titleEs": "Incidencias y avisos al anfitrión",
    "titleEn": "Guest incidents and host notifications",
    "es": "Pin AI puede registrar reportes elegibles del huésped y comunicar una incidencia al anfitrión con contexto. Hay estados e historial para su seguimiento y reconocimiento.",
    "en": "Pin AI can record eligible guest reports and notify the host of an incident with context. Status and history support follow-up and acknowledgement.",
    "limit": "Requiere activación y destinatarios configurados. Aviso entregado no significa leído o resuelto; no garantices reparación automática ni un plazo de respuesta.",
    "sources": [
      "src/pin-ai/guest/guest-incident.service.ts",
      "src/pin-ai/guest/guest-incident-notification.service.ts",
      "src/pin-ai/property-activation.ts"
    ]
  },
  {
    "id": "branding_domains",
    "titleEs": "Marca y dominio propios",
    "titleEn": "Custom branding and domains",
    "es": "El backend contempla experiencias con marca de la organización, revisión y aprobación de contenido y configuración de dominio para la publicación elegible.",
    "en": "The backend supports organization-branded experiences, content review and approval and domain configuration for eligible publication.",
    "limit": "Depende de la modalidad comercial, aprobación y verificación del dominio. No prometas marca blanca incluida en cualquier plan, dominio inmediato ni precio sin catálogo vigente.",
    "sources": [
      "src/services/branding/brand-policy.ts",
      "src/services/branding/enterprise-brand-onboarding.service.ts",
      "src/routes/organization.branding.routes.ts"
    ]
  },
  {
    "id": "team_permissions",
    "titleEs": "Equipo y permisos",
    "titleEn": "Team and permissions",
    "es": "Las organizaciones pueden gestionar usuarios de su equipo con roles y permisos; el personal de limpieza tiene su experiencia y asignaciones.",
    "en": "Organizations can manage team users with roles and permissions; cleaning staff have their own experience and assignments.",
    "limit": "La administración requiere permisos y alcance de organización. No prometas usuarios ilimitados, acceso universal ni una certificación de seguridad o privacidad no verificada.",
    "sources": [
      "src/routes/team.routes.ts",
      "src/routes/cleaner-account.routes.ts"
    ]
  },
  {
    "id": "device_health",
    "titleEs": "Estado de cerraduras y gateways",
    "titleEn": "Lock and gateway health",
    "es": "El panel contempla estado y alertas de dispositivos, cerraduras y gateways para ayudar a detectar problemas operativos.",
    "en": "The dashboard supports device, lock and gateway status and alerts to help identify operational issues.",
    "limit": "Los datos dependen del dispositivo y de las últimas señales recibidas; no equivalen a garantía de conectividad instantánea ni diagnóstico de una cerradura por este agente.",
    "sources": [
      "src/routes/dashboard.health.routes.ts",
      "src/routes/deviceHealth.routes.ts",
      "src/routes/deviceBattery.routes.ts"
    ]
  },
  {
    "id": "onboarding",
    "titleEs": "Cómo empezar",
    "titleEn": "Getting started",
    "es": "Para empezar visita pin-ngo.com. El proceso contempla registro, selección comercial y configuración de organización y propiedades, pagos, acceso y canales según las funciones que se usarán. Existen flujos de demostración y onboarding.",
    "en": "Start at pin-ngo.com. The process includes registration, offer selection and organization/property setup, payments, access and channels according to the features needed. Demo and onboarding workflows exist.",
    "limit": "No prometas duración fija, cita disponible, instalación incluida ni migración terminada. El agente puede explicar pasos, pero no crea cuentas ni agenda reuniones en esta llamada.",
    "sources": [
      "src/routes/public.signup.routes.ts",
      "src/routes/onboarding.appointments.routes.ts",
      "src/routes/org.ttlock.connect.v2.router.ts"
    ]
  },
  {
    "id": "billing_capacity",
    "titleEs": "Suscripción, capacidad y cargos",
    "titleEn": "Subscription, capacity and charges",
    "es": "La plataforma distingue suscripción y capacidad contratada, posibles paquetes de hardware y cargos de servicios por reserva. El área de facturación permite revisar información y opciones de gestión según el contrato.",
    "en": "The platform distinguishes subscription and contracted capacity, possible hardware packages and per-reservation service charges. Billing surfaces provide information and management options according to the contract.",
    "limit": "Consulta precios vigentes del backend y Stripe. No confundas mensualidad por cerradura con cargos por reserva ni inventes descuentos, prueba gratis, hardware incluido, penalidades o reembolsos de suscripción.",
    "sources": [
      "src/routes/billing.capacity.routes.ts",
      "src/routes/billing.overview.route.ts",
      "src/routes/billing.portal.route.ts",
      "src/services/sales-voice-pricing.service.ts"
    ]
  },
  {
    "id": "automation_limits",
    "titleEs": "Alcance de la automatización",
    "titleEn": "Automation scope",
    "es": "Pin&Go coordina procesos de llegada, comunicaciones, acceso, limpieza y seguimiento. Los motores APMS y Mission Control estructuran estados operativos y necesidades de atención.",
    "en": "Pin&Go coordinates arrival, communications, access, cleaning and monitoring. APMS engines and Mission Control structure operational status and attention needs.",
    "limit": "La existencia de código no confirma que un motor, worker o acción esté activo para toda cuenta. No prometas cero intervención humana, alertas de todos los eventos ni resolución automática de cualquier incidencia.",
    "sources": [
      "src/apms/engine-catalog.ts",
      "src/apms/mission-control-projection.ts",
      "src/services/guest-journey-enterprise-contract.test.ts"
    ]
  },
  {
    "id": "reviews",
    "titleEs": "Reseñas de huéspedes",
    "titleEn": "Guest reviews",
    "es": "El backend contempla reseñas de huéspedes, invitaciones elegibles, respuestas y moderación dentro de la plataforma.",
    "en": "The backend supports guest reviews, eligible invitations, host responses and moderation within the platform.",
    "limit": "Requiere habilitación y reglas de elegibilidad. No asegures que está activo para toda cuenta ni que publica o sincroniza reseñas con todas las OTA.",
    "sources": [
      "src/config/reviews.config.ts",
      "src/routes/dashboard.reviews.routes.ts",
      "src/routes/public-reviews.routes.ts"
    ]
  },
  {
    "id": "migration_compatibility",
    "titleEs": "Cambiar de PMS y compatibilidad",
    "titleEn": "Switching PMS and compatibility",
    "es": "Pin&Go contempla configuración de conexiones PMS y canales y mapeo de propiedades. Para evaluar un cambio conviene identificar el sistema actual, las propiedades, los canales y el equipo que ya utiliza el cliente.",
    "en": "Pin&Go supports PMS/channel connection configuration and property mapping. Evaluating a switch starts with the current system, properties, channels and existing equipment.",
    "limit": "No prometas importación universal, migración sin intervención, ausencia total de interrupciones o compatibilidad con cualquier cerradura, país o canal. Los requisitos concretos deben confirmarse.",
    "sources": [
      "src/routes/org.pms.routes.ts",
      "src/routes/dashboard.distribution-connection-center.route.ts",
      "src/routes/org.ttlock.connect.v2.router.ts"
    ]
  }
] as const;
