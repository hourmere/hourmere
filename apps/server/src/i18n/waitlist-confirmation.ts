import type { InterfaceLanguage } from '@hourmere/core/language'

export interface WaitlistConfirmationWords {
  verifyTitle: string
  verifyInstruction: string
  verifyAction: string
  verified: string
  removeTitle: string
  removeInstruction: string
  removeAction: string
  removed: string
  scannerNote: string
  incomplete: string
  invalid: string
  unavailable: string
  retry: string
  javascript: string
  language: string
}

export const waitlistConfirmationCatalogues: Record<InterfaceLanguage, WaitlistConfirmationWords> =
  {
    en: {
      verifyTitle: 'Confirm your waitlist email',
      verifyInstruction:
        'Confirm to receive emails when a time becomes available. Times are not reserved; the first successful booking gets the time.',
      verifyAction: 'Confirm email',
      verified:
        'Your email is confirmed. You are on the waitlist. Emails are sent when possible and do not guarantee a booking.',
      removeTitle: 'Leave the waitlist',
      removeInstruction:
        'Remove your entry and stop future waitlist emails. Your existing bookings will stay the same.',
      removeAction: 'Leave the waitlist',
      removed:
        'You have left the waitlist. You will receive no further waitlist emails for this entry.',
      scannerNote: 'Opening this page does not confirm your email or remove you from the waitlist.',
      incomplete: 'This link is incomplete. Open the full link from your waitlist email.',
      invalid:
        'This link has expired or is no longer valid. Use a current link from your waitlist email.',
      unavailable: 'We could not complete your request. Please try again.',
      retry: 'Too many requests. Please wait a minute and try again.',
      javascript: 'Enable JavaScript to use this private link.',
      language: 'Language',
    },
    'zh-CN': {
      verifyTitle: '确认候补邮箱',
      verifyInstruction:
        '确认后，有可约时间时我们会发送邮件。时间不会为你保留，先成功预约者获得该时段。',
      verifyAction: '确认邮箱',
      verified: '邮箱已确认，你已加入候补名单。邮件将尽可能发送，但不保证能够预约成功。',
      removeTitle: '退出候补名单',
      removeInstruction: '移除你的候补记录，停止接收后续候补邮件。已有预约不受影响。',
      removeAction: '退出候补名单',
      removed: '你已退出候补名单，不会再收到此候补记录的邮件。',
      scannerNote: '仅打开此页面不会确认邮箱，也不会将你移出候补名单。',
      incomplete: '此链接不完整，请打开候补邮件中的完整链接。',
      invalid: '此链接已过期或失效，请使用候补邮件中仍然有效的链接。',
      unavailable: '暂时无法完成请求，请重试。',
      retry: '请求过于频繁，请稍等一分钟后重试。',
      javascript: '请启用 JavaScript 以使用此私人链接。',
      language: '语言',
    },
    de: {
      verifyTitle: 'E-Mail-Adresse für die Warteliste bestätigen',
      verifyInstruction:
        'Bestätige deine E-Mail-Adresse, um über freie Termine informiert zu werden. Termine werden nicht reserviert. Wer zuerst erfolgreich bucht, erhält den Termin.',
      verifyAction: 'E-Mail-Adresse bestätigen',
      verified:
        'Deine E-Mail-Adresse ist bestätigt. Du stehst auf der Warteliste. Wir versenden E-Mails nach Möglichkeit; eine Buchung ist dadurch nicht garantiert.',
      removeTitle: 'Warteliste verlassen',
      removeInstruction:
        'Entferne deinen Eintrag und erhalte keine weiteren Wartelisten-E-Mails. Bestehende Buchungen bleiben erhalten.',
      removeAction: 'Warteliste verlassen',
      removed:
        'Du hast die Warteliste verlassen. Du erhältst keine weiteren E-Mails zu diesem Eintrag.',
      scannerNote:
        'Das Öffnen dieser Seite bestätigt deine E-Mail-Adresse nicht und entfernt dich nicht von der Warteliste.',
      incomplete:
        'Dieser Link ist unvollständig. Öffne den vollständigen Link aus deiner Wartelisten-E-Mail.',
      invalid:
        'Dieser Link ist abgelaufen oder nicht mehr gültig. Verwende einen aktuellen Link aus deiner Wartelisten-E-Mail.',
      unavailable: 'Deine Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.',
      retry: 'Zu viele Anfragen. Bitte warte eine Minute und versuche es erneut.',
      javascript: 'Aktiviere JavaScript, um diesen privaten Link zu verwenden.',
      language: 'Sprache',
    },
    fr: {
      verifyTitle: 'Confirmer votre adresse pour la liste d’attente',
      verifyInstruction:
        'Confirmez votre adresse pour recevoir un e-mail lorsqu’un créneau se libère. Aucun créneau n’est réservé : la première réservation réussie l’emporte.',
      verifyAction: 'Confirmer mon adresse',
      verified:
        'Votre adresse est confirmée. Vous êtes sur la liste d’attente. Les e-mails sont envoyés dans la mesure du possible et ne garantissent pas de réservation.',
      removeTitle: 'Quitter la liste d’attente',
      removeInstruction:
        'Supprimez votre inscription pour ne plus recevoir d’e-mails de cette liste d’attente. Vos réservations existantes seront conservées.',
      removeAction: 'Quitter la liste d’attente',
      removed:
        'Vous avez quitté la liste d’attente. Vous ne recevrez plus d’e-mails concernant cette inscription.',
      scannerNote:
        'Ouvrir cette page ne confirme pas votre adresse et ne vous retire pas de la liste d’attente.',
      incomplete:
        'Ce lien est incomplet. Ouvrez le lien complet figurant dans votre e-mail de liste d’attente.',
      invalid:
        'Ce lien a expiré ou n’est plus valide. Utilisez un lien encore valide dans votre e-mail de liste d’attente.',
      unavailable: 'Votre demande n’a pas pu aboutir. Veuillez réessayer.',
      retry: 'Trop de demandes. Veuillez patienter une minute avant de réessayer.',
      javascript: 'Activez JavaScript pour utiliser ce lien privé.',
      language: 'Langue',
    },
    es: {
      verifyTitle: 'Confirmar tu correo para la lista de espera',
      verifyInstruction:
        'Confirma tu correo para recibir avisos cuando haya un horario disponible. No se reserva ningún horario: se lo queda quien complete primero la reserva.',
      verifyAction: 'Confirmar correo',
      verified:
        'Tu correo está confirmado. Ya estás en la lista de espera. Los avisos se envían cuando es posible y no garantizan una reserva.',
      removeTitle: 'Salir de la lista de espera',
      removeInstruction:
        'Elimina tu inscripción para dejar de recibir correos de esta lista de espera. Tus reservas actuales se conservarán.',
      removeAction: 'Salir de la lista de espera',
      removed: 'Has salido de la lista de espera. No recibirás más correos sobre esta inscripción.',
      scannerNote: 'Abrir esta página no confirma tu correo ni te elimina de la lista de espera.',
      incomplete:
        'Este enlace está incompleto. Abre el enlace completo del correo de la lista de espera.',
      invalid:
        'Este enlace ha caducado o ya no es válido. Usa un enlace vigente del correo de la lista de espera.',
      unavailable: 'No se pudo completar tu solicitud. Vuelve a intentarlo.',
      retry: 'Demasiadas solicitudes. Espera un minuto y vuelve a intentarlo.',
      javascript: 'Activa JavaScript para usar este enlace privado.',
      language: 'Idioma',
    },
    'pt-BR': {
      verifyTitle: 'Confirme seu e-mail para a lista de espera',
      verifyInstruction:
        'Confirme seu e-mail para receber avisos quando surgir um horário. Os horários não são reservados: quem concluir a reserva primeiro fica com o horário.',
      verifyAction: 'Confirmar e-mail',
      verified:
        'Seu e-mail foi confirmado. Você está na lista de espera. Os avisos são enviados quando possível e não garantem uma reserva.',
      removeTitle: 'Sair da lista de espera',
      removeInstruction:
        'Remova sua inscrição para não receber mais e-mails desta lista de espera. Suas reservas atuais serão mantidas.',
      removeAction: 'Sair da lista de espera',
      removed: 'Você saiu da lista de espera. Não receberá mais e-mails sobre esta inscrição.',
      scannerNote: 'Abrir esta página não confirma seu e-mail nem remove você da lista de espera.',
      incomplete: 'Este link está incompleto. Abra o link completo no e-mail da lista de espera.',
      invalid:
        'Este link expirou ou não é mais válido. Use um link válido do e-mail da lista de espera.',
      unavailable: 'Não foi possível concluir sua solicitação. Tente novamente.',
      retry: 'Muitas solicitações. Aguarde um minuto e tente novamente.',
      javascript: 'Ative o JavaScript para usar este link privado.',
      language: 'Idioma',
    },
  }
