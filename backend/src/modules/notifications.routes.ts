// In-app notification bell + Server-Sent Events stream.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../middleware/async';
import { validate } from '../middleware/validate';

const router = Router();

// GET /api/notifications  — recent notifications for the current user
router.get(
  '/',
  validate({ query: z.object({ unread: z.coerce.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const where = {
      userId: req.user!.id,
      ...(req.query.unread ? { isRead: false } : {}),
    };
    const [data, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.notification.count({ where: { userId: req.user!.id, isRead: false } }),
    ]);
    res.json({ data, unreadCount });
  }),
);

// PATCH /api/notifications/:id/read
router.patch(
  '/:id/read',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: { isRead: true },
    });
    res.json({ ok: true });
  }),
);

// POST /api/notifications/read-all
router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, isRead: false },
      data: { isRead: true },
    });
    res.json({ ok: true });
  }),
);

// GET /api/notifications/stream  — Server-Sent Events for the live bell
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 10000\n\n');

  const timer = setInterval(async () => {
    const count = await prisma.notification.count({
      where: { userId: req.user!.id, isRead: false },
    });
    res.write(`event: unread\ndata: ${JSON.stringify({ unreadCount: count })}\n\n`);
  }, 15000);

  req.on('close', () => clearInterval(timer));
});

export default router;
