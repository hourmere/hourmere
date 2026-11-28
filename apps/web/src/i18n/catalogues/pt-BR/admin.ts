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

  // Custom team roles
  'Roles and permissions': 'Funções e permissões',
  'Loading custom roles…': 'Carregando funções personalizadas…',
  'Could not load custom roles.': 'Não foi possível carregar as funções personalizadas.',
  'Shared team roster and event types, plus personal settings and assigned-host actions.':
    'Lista compartilhada de membros e tipos de evento, configurações pessoais e ações de anfitrião atribuído.',
  'Member access plus team settings, invitations, eligible member removal, scheduling and team integrations.':
    'Acesso de membro, configurações da equipe, convites, remoção de membros elegíveis, agendamento e integrações da equipe.',
  'Admin access plus fixed role changes, ownership transfer, audit retention and custom role management.':
    'Acesso de administrador, alterações de funções fixas, transferência de propriedade, retenção da auditoria e gestão de funções personalizadas.',
  'Fixed roles are read-only here. Custom roles keep base Member access. They cannot grant member management, private booking data or team exports.':
    'As funções fixas são somente leitura aqui. As funções personalizadas mantêm o acesso básico de membro. Elas não concedem acesso à gestão de membros, aos dados privados de reservas ou às exportações da equipe.',
  'Custom roles are on for this team.':
    'As funções personalizadas estão ativadas para esta equipe.',
  'Custom roles are off for this team.':
    'As funções personalizadas estão desativadas para esta equipe.',
  'Turn off custom roles': 'Desativar funções personalizadas',
  'Turn on custom roles': 'Ativar funções personalizadas',
  'Turning off custom roles pauses their additional access and keeps the saved roles and assignments.':
    'Desativar as funções suspende o acesso adicional e preserva as funções e atribuições salvas.',
  'Turning on custom roles lets owners publish roles and assign them to eligible Members.':
    'A ativação permite que proprietários publiquem funções e as atribuam a membros elegíveis.',
  'Members assigned a custom role who must renew after activation: {count}':
    'Membros com função personalizada que precisam renovar o acesso após a ativação: {count}',
  'Confirm turning off custom roles': 'Confirmar desativação das funções personalizadas',
  'Confirm turning on custom roles': 'Confirmar ativação das funções personalizadas',
  'Custom roles turned off.': 'Funções personalizadas desativadas.',
  'Custom roles turned on.': 'Funções personalizadas ativadas.',
  'Custom roles': 'Funções personalizadas',
  'Create custom role': 'Criar função personalizada',
  'No custom roles have been published.': 'Nenhuma função personalizada foi publicada.',
  'Revision {revision}': 'Versão {revision}',
  'Edit custom role': 'Editar função personalizada',
  'Edit custom role {name}': 'Editar função personalizada {name}',
  'Archive custom role': 'Arquivar função personalizada',
  'Archive custom role {name}': 'Arquivar função personalizada {name}',
  'Archiving removes the role from future assignments and keeps its revision history.':
    'Funções arquivadas não podem mais ser atribuídas e mantêm o histórico de versões.',
  'Custom role name': 'Nome da função personalizada',
  'Each preset adds only the actions shown. Base Member access continues in every area.':
    'Cada predefinição adiciona apenas as ações exibidas. O acesso básico de membro é mantido em todas as áreas.',
  'Publishing updates every member assigned this role. Affected members must renew to use additional access.':
    'A publicação atualiza a função de todos os membros que a têm atribuída. Eles precisam renovar o acesso para usar as ações adicionais.',
  'Custom role archived.': 'Função personalizada arquivada.',
  'Custom role published.': 'Função personalizada publicada.',
  'Confirm archive': 'Confirmar arquivamento',
  'Create and publish role': 'Criar e publicar função',
  'Publish new revision': 'Publicar nova versão',
  'Access preset for {area}': 'Predefinição de acesso para {area}',
  'No additional access': 'Sem acesso adicional',
  Custom: 'Personalizado',
  'Team setup readiness': 'Prontidão da configuração da equipe',
  Branding: 'Identidade visual',
  'View aggregate booking activity': 'Ver atividade agregada de reservas',
  'View team branding': 'Ver identidade visual da equipe',
  'Edit team branding': 'Editar identidade visual da equipe',
  'Upload the team logo': 'Enviar logotipo da equipe',
  'Edit event notifications': 'Editar notificações de eventos',
  'Activate round-robin events': 'Ativar eventos de distribuição alternada',
  'Assign hosts': 'Atribuir anfitriões',
  'Create event types': 'Criar tipos de evento',
  'Delete event types': 'Excluir tipos de evento',
  'Duplicate event types': 'Duplicar tipos de evento',
  'View eligible hosts and their readiness': 'Ver anfitriões elegíveis e sua prontidão',
  'Edit event types': 'Editar tipos de evento',
  'View team setup readiness': 'Ver a prontidão da configuração da equipe',
  'Preview routing with sample data': 'Pré-visualizar o encaminhamento com dados de exemplo',
  'View routing forms': 'Ver formulários de encaminhamento',
  'Preview workflows with sample data': 'Pré-visualizar fluxos de trabalho com dados de exemplo',
  'View workflow definitions': 'Ver definições de fluxos de trabalho',
  'View workflow run metadata': 'Ver metadados de execuções de fluxos de trabalho',
  'Change custom role': 'Alterar função personalizada',
  'Change custom role for {name}': 'Alterar função personalizada de {name}',
  'Custom role assignment saved.': 'Atribuição da função personalizada salva.',
  'Loading the current assignment…': 'Carregando a atribuição atual…',
  'Could not load the current assignment.': 'Não foi possível carregar a atribuição atual.',
  'Your access to this assignment could not be verified.':
    'Não foi possível verificar seu acesso a esta atribuição.',
  'Custom role for this member': 'Função personalizada deste membro',
  'Fixed Member only': 'Apenas função fixa de membro',
  'The member keeps base Member access.': 'O membro mantém o acesso básico de membro.',
  'Additional actions gained': 'Ações adicionais concedidas',
  'Additional actions lost': 'Ações adicionais removidas',
  'Affected members must verify in their browser, replace their API keys and reconnect their MCP apps to use additional access.':
    'Os membros afetados precisam se verificar no navegador, substituir as chaves de API e reconectar os aplicativos MCP para usar o acesso adicional.',
  'Save custom role assignment': 'Salvar atribuição da função personalizada',
  None: 'Nenhuma',
  'Your fixed team role applies.': 'Sua função fixa na equipe se aplica.',
  'Your access to make this change could not be verified.':
    'Não foi possível verificar sua permissão para fazer esta alteração.',
  'The change could not be saved. Try again.':
    'Não foi possível salvar a alteração. Tente novamente.',
  'Confirm your identity before changing team roles.':
    'Confirme sua identidade antes de alterar as funções da equipe.',
  'Your team access was renewed.': 'Seu acesso à equipe foi renovado.',
  'Your current team access could not be checked.':
    'Não foi possível verificar seu acesso atual à equipe.',
  'Renew team access': 'Renovar acesso à equipe',
  'Your team permissions changed. Verify your identity to use your current access in this browser.':
    'Suas permissões de equipe mudaram. Confirme sua identidade para usar seu acesso atual neste navegador.',
  'Replace affected API keys and reconnect affected MCP apps separately.':
    'Substitua as chaves de API afetadas e reconecte separadamente os aplicativos MCP afetados.',
  'Confirm your identity to renew team access.':
    'Confirme sua identidade para renovar o acesso à equipe.',
  'Verify and renew team access': 'Verificar e renovar o acesso à equipe',
  'Review team access for this key': 'Revisar o acesso à equipe desta chave',
  'Base team role: {role}': 'Função básica na equipe: {role}',
  'Additional team actions available within this scope':
    'Ações adicionais da equipe disponíveis neste escopo',
  'Confirm and create key': 'Confirmar e criar chave',
  'Renew your browser’s team access in Settings before issuing a new credential.':
    'Renove o acesso do navegador à equipe nas configurações antes de emitir uma nova credencial.',
  'Review team access for this connection': 'Revisar o acesso à equipe desta conexão',
  'Additional team actions available to this app':
    'Ações adicionais da equipe disponíveis para este aplicativo',
  'Team actions available in this browser': 'Ações da equipe disponíveis neste navegador',
  'Your custom role adds these actions in this team.':
    'Sua função personalizada adiciona estas ações nesta equipe.',
  'Your current team permissions do not include viewing branding.':
    'Suas permissões atuais na equipe não incluem visualizar a identidade visual.',
  'Some memberships have an ambiguous fixed role. Resolve their roles before turning on custom roles.':
    'Alguns membros têm uma função fixa ambígua. Corrija essas funções antes de ativar as funções personalizadas.',
  'Team access changed. Review it again before creating the key.':
    'O acesso à equipe mudou. Revise-o novamente antes de criar a chave.',
  'Team access changed. Restart this connection from your AI app.':
    'O acesso à equipe mudou. Reinicie a conexão pelo seu aplicativo de IA.',

  // Booking handoff mail status
  'Attendee cancellation email': 'E-mail de cancelamento para participantes',
  'Attendee confirmation email': 'E-mail de confirmação para participantes',
  'Mail server acceptance unconfirmed': 'Aceitação pelo servidor de e-mail não confirmada',
  'Accepted by the mail server': 'Aceito pelo servidor de e-mail',
  'Email delivery incomplete': 'Entrega de e-mail incompleta',
  'Email delivery unavailable': 'Entrega de e-mail indisponível',

  // Effective team page permissions
  'No event types yet.': 'Ainda não há tipos de evento.',
}
