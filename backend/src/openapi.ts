// Minimal but valid OpenAPI 3.0 document. The route surface is large; this
// documents the auth flow + representative resource shapes and lists every
// mounted resource path group so /api/docs is a useful live reference.
export const openapiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Reality CRM API',
    version: '1.0.0',
    description:
      'Real Estate CRM API. All money values are integer paise (string-encoded in JSON). Auth: JWT Bearer access tokens (15m) + refresh tokens (7d).',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: { email: { type: 'string' }, password: { type: 'string' } },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
          user: { type: 'object' },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/login': {
      post: {
        tags: ['Auth'],
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } },
        },
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
          401: { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/refresh': { post: { tags: ['Auth'], security: [], responses: { 200: { description: 'New tokens' } } } },
    '/auth/me': { get: { tags: ['Auth'], responses: { 200: { description: 'Current user' } } } },

    '/campaigns': {
      get: { tags: ['Campaigns'], responses: { 200: { description: 'Paginated campaigns' } } },
      post: { tags: ['Campaigns'], responses: { 201: { description: 'Created' } } },
    },
    '/campaigns/{id}/analytics': { get: { tags: ['Campaigns'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'CPL, conversion, ROI' } } } },

    '/leads': { get: { tags: ['Leads'], responses: { 200: { description: 'Paginated leads' } } }, post: { tags: ['Leads'], responses: { 201: { description: 'Created' } } } },
    '/leads/{id}/convert': { post: { tags: ['Leads'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Account+Contact+Opportunity created' } } } },

    '/accounts': { get: { tags: ['Accounts'], responses: { 200: { description: 'Paginated accounts' } } }, post: { tags: ['Accounts'], responses: { 201: { description: 'Created' } } } },
    '/opportunities': { get: { tags: ['Opportunities'], responses: { 200: { description: 'List' } } } },
    '/opportunities/pipeline': { get: { tags: ['Opportunities'], responses: { 200: { description: 'Pipeline by stage' } } } },
    '/opportunities/forecast': { get: { tags: ['Opportunities'], responses: { 200: { description: 'Weighted forecast' } } } },
    '/site-visits': { get: { tags: ['Site Visits'], responses: { 200: { description: 'List' } } }, post: { tags: ['Site Visits'], responses: { 201: { description: 'Scheduled' } } } },
    '/inventory/projects': { get: { tags: ['Inventory'], responses: { 200: { description: 'Projects' } } } },
    '/inventory/units/{id}/hold': { post: { tags: ['Inventory'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Unit held' } } } },
    '/quotations': { get: { tags: ['Quotations'], responses: { 200: { description: 'List' } } }, post: { tags: ['Quotations'], responses: { 201: { description: 'Created' } } } },
    '/bookings': { get: { tags: ['Bookings'], responses: { 200: { description: 'List' } } }, post: { tags: ['Bookings'], responses: { 201: { description: 'Created' } } } },
    '/bookings/{id}/ledger': { get: { tags: ['Finance'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Outstanding ledger' } } } },
    '/bookings/{id}/receipts': { post: { tags: ['Finance'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 201: { description: 'Receipt recorded' } } } },
    '/demands/overdue': { get: { tags: ['Finance'], responses: { 200: { description: 'Overdue demands' } } } },
    '/reports/leads': { get: { tags: ['Reports'], responses: { 200: { description: 'Lead summary report' } } } },
    '/dashboard/kpis': { get: { tags: ['Dashboard'], responses: { 200: { description: 'Role KPIs' } } } },
    '/admin/users': { get: { tags: ['Admin'], responses: { 200: { description: 'Users' } } }, post: { tags: ['Admin'], responses: { 201: { description: 'Created' } } } },
    '/search': { get: { tags: ['Search'], parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Global search results' } } } },
  },
} as const;
