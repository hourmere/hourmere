export const admin = {
  '{0} location options are configured. Manage them through REST, MCP or CLI. Saving other fields keeps these options.':
    'Há {0} opções de local configuradas. Gerencie-as via REST, MCP ou CLI. Salvar outros campos mantém essas opções.',
  // Team member single sign-on
  'Send verification email': 'Enviar e-mail de verificação',
  'Email verification link': 'Link de verificação por e-mail',
  'Verify email link': 'Confirmar link do e-mail',
  'Email verification complete.': 'E-mail verificado.',
  'Check your Hourmere email. Copy the verification link and paste it here.':
    'Confira a caixa de entrada do e-mail usado no Hourmere. Copie o link de verificação e cole-o aqui.',
  'Identity verification is unavailable.': 'A verificação de identidade está indisponível.',
  'Could not verify that link. Check the link or request a new email.':
    'Não foi possível verificar o link. Confira o link ou solicite um novo e-mail.',
  'Could not start identity verification. Try again.':
    'Não foi possível iniciar a verificação de identidade. Tente novamente.',
  'Working…': 'Processando…',

  // Booking handoff
  'Booking handoff': 'Transferência de reserva',
  'Handoff status': 'Status da transferência',
  'Preview handoff': 'Verificar transferência',
  'Refresh handoff': 'Atualizar transferência',
  'Confirm handoff': 'Confirmar transferência',
  'Checking handoff…': 'Verificando a transferência…',
  'Confirming handoff…': 'Confirmando a transferência…',
  'Replacement host': 'Novo anfitrião',
  'Proposed time': 'Horário proposto',
  'Previewed at': 'Verificado em',
  'Consent deadline: {time}': 'Prazo para consentimento: {time}',
  'Pending approvals: {count}': 'Consentimentos pendentes: {count}',
  'Preview the replacement host and time. A preview does not reserve the slot.':
    'Verifique o novo anfitrião e o horário. A verificação não reserva o horário.',
  'No handoff offer is available yet.': 'Ainda não há uma proposta de transferência.',
  'Participant consent is pending. The booker and every guest must approve. The original booking stays confirmed.':
    'Há consentimentos pendentes. Quem reservou e cada convidado precisam dar seu consentimento. A reserva original continua confirmada.',
  'All participants have approved.': 'Todos os participantes deram seu consentimento.',
  'Consent has expired. The offer leaves the booking unchanged. A new offer needs new approvals.':
    'O prazo para consentimento expirou. A reserva permanece inalterada. Uma nova proposta exige novos consentimentos.',
  'This handoff offer is closed. Use manual rebooking if you still need to replace the booking.':
    'Esta proposta de transferência foi encerrada. Se ainda precisar substituir a reserva, faça uma nova manualmente.',
  'That time is unavailable for the replacement host. Refresh the preview or use manual rebooking.':
    'O novo anfitrião não está disponível nesse horário. Atualize a verificação ou faça uma nova reserva manualmente.',
  'The proposed time is available.': 'O horário proposto está disponível.',
  'Calendar availability could not be verified. Ask the replacement host to check calendar sync, then refresh the preview.':
    'Não foi possível verificar a disponibilidade da agenda. Peça ao novo anfitrião que verifique a sincronização e atualize a verificação.',
  'The meeting location is unavailable. Ask the replacement host to check their meeting setup, then refresh the preview.':
    'O local da reunião não está disponível. Peça ao novo anfitrião que verifique a configuração da reunião e atualize a verificação.',
  'This handoff changed. Refresh the preview before confirming.':
    'Esta transferência mudou. Atualize a verificação antes de confirmar.',
  'This booking is no longer eligible for handoff. Refresh the booking or coordinate a replacement manually.':
    'Esta reserva não pode mais ser transferida. Atualize a reserva ou coordene uma substituição manualmente.',
  'The replacement host is no longer eligible. Check the event type’s host setup, then refresh the preview.':
    'O novo anfitrião não atende mais aos requisitos. Verifique a configuração de anfitriões do tipo de evento e atualize a verificação.',
  'Booking handoff is unavailable.': 'A transferência de reserva não está disponível.',
  'Could not check the handoff. Refresh to try again.':
    'Não foi possível verificar a transferência. Atualize para tentar novamente.',
  'Could not confirm whether the handoff completed. Refresh its status before trying again.':
    'Não foi possível verificar se a transferência foi concluída. Atualize o status antes de tentar novamente.',
  'Confirming checks the time again, cancels the original booking and creates a separate replacement.':
    'A confirmação verifica o horário novamente, cancela a reserva original e cria uma reserva independente.',
  'Booking handoff completed.': 'A transferência de reserva foi concluída.',
  'The original booking was cancelled and a replacement was created. Cancellation and confirmation notices were queued.':
    'A reserva original foi cancelada e uma nova foi criada. Os avisos de cancelamento e confirmação foram colocados na fila de envio.',
  'View replacement booking': 'Ver nova reserva',
  'The replacement meeting link is being prepared. Refresh the handoff to check its status.':
    'O link da nova reunião está sendo preparado. Atualize a transferência para verificar o status.',
  'The replacement meeting link is ready.': 'O link da nova reunião está pronto.',
  'The replacement meeting link could not be verified. The replacement booking is confirmed. Ask its host to check their meeting account, then refresh the handoff.':
    'Não foi possível verificar o link da nova reunião. A nova reserva está confirmada. Peça ao anfitrião que verifique sua conta de reuniões e atualize a transferência.',
  'The replacement meeting status is unavailable. Refresh the handoff to check again.':
    'O status da nova reunião não está disponível. Atualize a transferência para verificar novamente.',
  'Cleanup of the original meeting is pending.': 'A remoção da reunião original está pendente.',
  'Cleanup of the original meeting could not be verified. Ask the original meeting account owner to check for a remaining meeting.':
    'Não foi possível verificar a remoção da reunião original. Peça ao titular da conta original que verifique se a reunião ainda existe.',
  'Google Meet': 'Google Meet',
  Zoom: 'Zoom',
  Location: 'Local',
  'Your time zone: {zone}': 'Seu fuso horário: {zone}',
  'Sign in with this team’s SSO to continue.': 'Entre com o SSO desta equipe para continuar.',

  // Team ownership transfer
  'Team ownership transfer': 'Transferência de propriedade da equipe',
  'Only owners can manage admins.': 'Somente proprietários podem gerenciar administradores.',
  'Offer ownership to {name}': 'Oferecer a propriedade a {name}',
  'Choose a team member below to offer them ownership.':
    'Selecione um membro da equipe abaixo para oferecer a propriedade.',
  'Review ownership transfer': 'Revisar a transferência de propriedade',
  'You will become an admin when the recipient accepts.':
    'Quando a pessoa destinatária aceitar, você passará a ser administrador.',
  '{initiator} will become an admin.': '{initiator} passará a ser administrador.',
  '{recipient} will become the team owner.': '{recipient} assumirá a propriedade da equipe.',
  'Personal spaces, calendars and provider connections stay with their current accounts. API keys and agent authorizations are not transferred.':
    'Espaços pessoais, calendários e conexões com provedores permanecem nas contas atuais. Chaves de API e autorizações de agentes não são transferidas.',
  'Send transfer offer': 'Enviar proposta de transferência',
  'Accept ownership': 'Aceitar a propriedade',
  'Decline transfer': 'Recusar transferência',
  'Revoke transfer': 'Revogar transferência',
  'Transfer deadline': 'Prazo para a transferência',
  'Refresh transfer status': 'Atualizar o status da transferência',
  'Checking ownership transfer status…': 'Verificando o status da transferência…',
  'Could not check the transfer status.': 'Não foi possível verificar o status da transferência.',
  'No pending transfer offer.': 'Não há proposta de transferência pendente.',
  'Transfer offer pending.': 'Proposta de transferência pendente.',
  'Ownership transfer completed.': 'Transferência de propriedade concluída.',
  'The transfer offer was revoked or declined.':
    'A proposta de transferência foi revogada ou recusada.',
  'You declined the transfer offer.': 'Você recusou a proposta de transferência.',
  'The transfer offer expired.': 'A proposta de transferência expirou.',
  'The transfer offer is no longer valid.': 'A proposta de transferência perdeu a validade.',
  'A transfer offer is already pending.': 'Já existe uma proposta de transferência pendente.',
  'This transfer offer is no longer available.':
    'Esta proposta de transferência não está mais disponível.',
  'Memberships managed by your identity provider cannot be transferred.':
    'Vínculos gerenciados pelo seu provedor de identidade não podem participar da transferência.',
  'The team needs another accepted SSO recovery owner before transferring ownership.':
    'A equipe precisa de outro proprietário que tenha aceitado a função de recuperação de SSO antes de transferir a propriedade.',
  'This ownership transfer action is unavailable to you.':
    'Esta ação de transferência de propriedade não está disponível para você.',
  'Could not update the transfer. Refresh its status before trying again.':
    'Não foi possível atualizar a transferência. Atualize o status antes de tentar novamente.',
  'Verify your identity for this ownership transfer.':
    'Verifique sua identidade para esta transferência de propriedade.',
  'Try again in {0} seconds.': 'Tente novamente em {0} segundos.',
  'Reload team': 'Recarregar equipe',
  'Unnamed team member': 'Membro da equipe sem nome',
  'Too many requests. Please wait and try again later.':
    'Muitas solicitações. Aguarde e tente novamente mais tarde.',
  'Owner roles change only through a confirmed transfer. The team must retain at least one owner.':
    'A função de proprietário só muda após uma transferência confirmada. A equipe deve manter pelo menos um proprietário.',
}
