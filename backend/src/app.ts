import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import { corsOrigins } from './config/env';
import { logger } from './lib/logger';
import { installBigIntJson } from './lib/serialize';
import { authenticate } from './middleware/auth';
import { requireTenant } from './middleware/tenant';
import { errorHandler, notFoundHandler } from './middleware/error';
import { openapiDocument } from './openapi';

import authRoutes from './modules/auth.routes';
import campaignRoutes from './modules/campaigns.routes';
import leadRoutes from './modules/leads.routes';
import accountRoutes from './modules/accounts.routes';
import opportunityRoutes from './modules/opportunities.routes';
import siteVisitRoutes from './modules/siteVisits.routes';
import inventoryRoutes from './modules/inventory.routes';
import quotationRoutes from './modules/quotations.routes';
import bookingRoutes from './modules/bookings.routes';
import financeRoutes from './modules/finance.routes';
import reportRoutes from './modules/reports.routes';
import dashboardRoutes from './modules/dashboard.routes';
import adminRoutes from './modules/admin.routes';
import customFieldRoutes from './modules/customFields.routes';
import routingRoutes from './modules/routing.routes';
import partnerRoutes from './modules/partner.routes';
import notificationRoutes from './modules/notifications.routes';
import searchRoutes from './modules/search.routes';
import aiRoutes from './modules/ai.routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(pinoHttp({ logger }));
  installBigIntJson(app);

  // Rate limit auth + public surface.
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true });
  const partnerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));

  // Public auth routes (rate-limited).
  app.use('/api/auth', authLimiter, authRoutes);

  // Server-to-server partner intake (broker portal). Gated by API key inside
  // the router, so it sits outside the JWT-authenticated router below.
  app.use('/api/partner', partnerLimiter, partnerRoutes);

  // Everything below requires a valid access token.
  const api = express.Router();
  api.use(authenticate);
  api.use(requireTenant);

  api.use('/campaigns', campaignRoutes);
  api.use('/leads', leadRoutes);
  api.use('/accounts', accountRoutes);
  api.use('/opportunities', opportunityRoutes);
  api.use('/site-visits', siteVisitRoutes);
  api.use('/inventory', inventoryRoutes);
  api.use('/quotations', quotationRoutes);
  api.use('/bookings', bookingRoutes);
  api.use('/reports', reportRoutes);
  api.use('/dashboard', dashboardRoutes);
  api.use('/admin', adminRoutes);
  api.use('/custom-fields', customFieldRoutes);
  api.use('/routing', routingRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/search', searchRoutes);
  api.use('/ai', aiRoutes);
  // Finance/demand/receipt + payment-plan routes use full paths (/bookings/.., /demands/.., /receipts/.., /payment-plans).
  api.use('/', financeRoutes);

  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
