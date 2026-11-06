import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  Icon,
  INodeProperties,
} from 'n8n-workflow'

export class HourmereApi implements ICredentialType {
  icon: Icon = {
    light: 'file:../nodes/Hourmere/hourmere.svg',
    dark: 'file:../nodes/Hourmere/hourmere.dark.svg',
  }
  name = 'hourmereApi'
  displayName = 'Hourmere API'
  documentationUrl = 'https://hourmere.com/docs/n8n'
  properties: INodeProperties[] = [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://hourmere.example.com',
      description: 'Your Hourmere instance URL, without /api/v1',
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'Use Read for reads, Bookings for booking actions, and Full only for triggers',
    },
  ]
  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
  }
  test: ICredentialTestRequest = {
    request: {
      baseURL:
        '={{$credentials.baseUrl.endsWith("/") ? $credentials.baseUrl.slice(0, -1) : $credentials.baseUrl}}',
      url: '/api/v1/profile',
      method: 'GET',
      skipSslCertificateValidation: false,
      disableFollowRedirect: true,
    },
  }
}
