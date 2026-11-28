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

  // Team booking bulk cancellation
  'Select bookings to cancel': 'Selecionar agendamentos para cancelar',
  'Select this page': 'Selecionar esta página',
  'Exit selection': 'Sair da seleção',
  'Select booking: {event}, {time}': 'Selecionar agendamento: {event}, {time}',
  '{count} selected on this page (maximum {limit}).':
    'Agendamentos selecionados nesta página: {count} (máximo de {limit}).',
  'Review cancellation': 'Revisar cancelamento',
  'Refresh bookings': 'Atualizar agendamentos',
  'Review bulk cancellation': 'Revisar cancelamento em lote',
  'Bulk cancellation status': 'Status do cancelamento em lote',
  'View bulk cancellation': 'Ver cancelamento em lote',
  'Retry submission': 'Tentar enviar novamente',
  'Cancel {count} booking': 'Cancelar {count} agendamento',
  'Cancel {count} bookings': 'Cancelar {count} agendamentos',
  '{count} selected. {eligible} eligible to cancel.':
    'Agendamentos selecionados: {count}. Desses, {eligible} podem ser cancelados.',
  'Cancellation is irreversible. Existing cancellation notifications will be queued as applicable. Some bookings may become ineligible before they are processed.':
    'O cancelamento é irreversível. As notificações de cancelamento habituais entrarão na fila de envio quando aplicável. Alguns agendamentos podem deixar de atender aos requisitos até serem processados.',
  'Selection expired or changed. Refresh the bookings and select again.':
    'A seleção expirou ou mudou. Atualize os agendamentos e selecione novamente.',
  'The confirmation expired. Select bookings again to start a new cancellation.':
    'A confirmação expirou. Selecione os agendamentos novamente para iniciar um novo cancelamento.',
  'This batch is no longer available. Refresh the bookings before starting again.':
    'Este lote não está mais disponível. Atualize os agendamentos antes de recomeçar.',
  'Checking whether your cancellation was accepted…': 'Verificando se seu cancelamento foi aceito…',
  'Your cancellation has not been confirmed yet. You can safely retry this submission.':
    'Seu cancelamento ainda não foi confirmado. Você pode reenviar esta solicitação sem criar uma duplicata.',
  'Bulk cancellation queued': 'Cancelamento em lote na fila',
  'Bulk cancellation in progress': 'Cancelamento em lote em andamento',
  'Bulk cancellation completed': 'Cancelamento em lote concluído',
  '{cancelled} cancelled, {pending} pending, {other} skipped or failed.':
    'Cancelados: {cancelled}. Pendentes: {pending}. Ignorados ou com falha: {other}.',
  'Closing this view does not stop an accepted cancellation.':
    'Ao fechar esta janela, o processamento de um cancelamento aceito continua.',
  'To try an unsuccessful booking again, refresh the list and select it if it is still eligible.':
    'Para tentar cancelar um agendamento novamente, atualize a lista e selecione-o se ainda for possível cancelá-lo.',
  'Eligible to cancel': 'Pode ser cancelado',
  'Awaiting processing': 'Aguardando processamento',
  'Already cancelled': 'Já estava cancelado',
  'Booking already started': 'O agendamento já começou',
  'Unsupported booking (including paid or imported bookings)':
    'Agendamento não compatível (inclusive agendamentos com pagamentos ou importados)',
  'Booking unavailable': 'Agendamento indisponível',
  'A required host left the team': 'Um anfitrião obrigatório saiu da equipe',
  'Team authority was lost': 'As permissões de administração da equipe foram perdidas',
  'Could not process the booking': 'Não foi possível processar o agendamento',
  'No bookings on this page can be selected.':
    'Nenhum agendamento pode ser selecionado nesta página.',
  'The team has reached its bulk cancellation limit. Try again shortly.':
    'A equipe atingiu o limite de cancelamentos em lote. Tente novamente em instantes.',
  'Try again in {seconds} seconds.': 'Tente novamente em {seconds} segundos.',
  'Filters applied': 'Filtros aplicados',
  Team: 'Equipe',
  Upcoming: 'Próximos',
  'All bookings': 'Todos os agendamentos',
  Past: 'Anteriores',
  'Oldest first': 'Mais antigos primeiro',
  'Newest first': 'Mais recentes primeiro',
  'All statuses': 'Todos os status',
  Cancelled: 'Cancelado',
  'Starts at or after': 'Início a partir de',
  'Starts before': 'Início antes de',
  'Ends after': 'Término após',
  'Ends at or before': 'Término até',
  'Deleted event type': 'Tipo de evento excluído',
  'Booking ID': 'ID do agendamento',
  'Show more bookings': 'Mostrar mais agendamentos',
  'Submission could not be confirmed. This page will keep checking its status.':
    'Não foi possível confirmar o envio. Esta página continuará verificando o status.',
  'No selected bookings are eligible for cancellation. Review a fresh selection.':
    'Nenhuma das reservas selecionadas pode ser cancelada. Revise uma nova seleção.',
  Bookings: 'Reservas',
  Order: 'Ordem',
}
