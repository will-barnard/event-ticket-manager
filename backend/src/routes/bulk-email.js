const express = require('express');
const { Resend } = require('resend');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const superAdminMiddleware = require('../middleware/superadmin');

const router = express.Router();

// Rate limiting - track last send time per user
const lastSendTimes = new Map();
const RATE_LIMIT_MS = 60000; // 1 minute between bulk sends

// Create Resend client
const isEmailConfigured = process.env.RESEND_API_KEY;
let resend = null;
if (isEmailConfigured) {
  resend = new Resend(process.env.RESEND_API_KEY);
}

// Send test email
router.post('/test', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const { subject, body, testEmail } = req.body;

    if (!subject || !body || !testEmail) {
      return res.status(400).json({ error: 'Subject, body, and test email address are required' });
    }

    if (!isEmailConfigured || !transporter) {
      return res.status(503).json({ error: 'Email service is not configured' });
    }

    // Send test email
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: testEmail,
      subject: `[TEST] ${subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #f44336; color: white; padding: 15px; text-align: center; font-weight: bold; margin-bottom: 20px;">
            🧪 TEST EMAIL - This is a preview
          </div>
          ${body}
          <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #eee; color: #666; font-size: 12px;">
            <p>This is a test email sent from the Bulk Email tool.</p>
            <p>Sent by: ${req.user.name || req.user.email}</p>
          </div>
        </div>
      `
    });

    console.log(`📧 Test email sent to ${testEmail} by ${req.user.email}`);

    res.json({
      success: true,
      message: `Test email sent to ${testEmail}`
    });
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

// Send bulk email
router.post('/send', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const { subject, body, eventIds } = req.body;

    if (!subject || !body) {
      return res.status(400).json({ error: 'Subject and body are required' });
    }

    if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ error: 'At least one event must be selected' });
    }

    if (!isEmailConfigured || !resend) {
      return res.status(503).json({ error: 'Email service is not configured' });
    }

    // Check rate limit
    const userId = req.user.id;
    const lastSendTime = lastSendTimes.get(userId);
    const now = Date.now();

    if (lastSendTime && (now - lastSendTime) < RATE_LIMIT_MS) {
      const remainingSeconds = Math.ceil((RATE_LIMIT_MS - (now - lastSendTime)) / 1000);
      return res.status(429).json({ 
        error: `Please wait ${remainingSeconds} seconds before sending another bulk email` 
      });
    }
    
    // Get tickets based on selected events - only include valid tickets
    const placeholders = eventIds.map((_, i) => `$${i + 1}`).join(', ');
    const query = `
      SELECT DISTINCT t.email, t.name, e.name as event_name
      FROM tickets t
      LEFT JOIN events e ON t.event_id = e.id
      WHERE t.event_id IN (${placeholders})
      AND t.email IS NOT NULL
      AND t.email != ''
      AND (t.status IS NULL OR t.status = 'valid')
      ORDER BY t.email
    `;

    const result = await db.query(query, eventIds);
    const recipients = result.rows;

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No valid recipients found for selected events' });
    }
    
    // Check daily email limit after getting recipients count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const quotaResult = await db.query(
      'SELECT COUNT(*) as sent_today FROM email_send_log WHERE sent_at >= $1 AND success = true',
      [todayStart]
    );
    
    const sentToday = parseInt(quotaResult.rows[0].sent_today);
    const dailyLimit = 100;
    const remaining = Math.max(0, dailyLimit - sentToday);
    
    if (remaining === 0) {
      return res.status(429).json({ 
        error: 'Daily email limit of 100 emails reached. Please try again tomorrow.'
      });
    }
    
    if (recipients.length > remaining) {
      return res.status(429).json({ 
        error: `Cannot send ${recipients.length} emails. Only ${remaining} emails remaining in today's quota of 100.`
      });
    }

    // Update rate limit timestamp
    lastSendTimes.set(userId, now);

    // Send emails with delay (6 seconds between each = 10 per minute)
    let sentCount = 0;
    let failedCount = 0;
    const errors = [];

    for (const recipient of recipients) {
      try {
        await resend.emails.send({
          from: process.env.EMAIL_FROM,
          to: recipient.email,
          subject: subject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              ${body}
              <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #eee; color: #666; font-size: 12px;">
                <p>Ticket holder: ${recipient.name}</p>
              </div>
            </div>
          `
        });
        
        // Log successful send
        await db.query(
          'INSERT INTO email_send_log (recipient_email, send_type, success) VALUES ($1, $2, $3)',
          [recipient.email, 'bulk_email', true]
        );
        
        sentCount++;

        // 6-second delay between emails (10 per minute)
        if (sentCount < recipients.length) {
          await new Promise(resolve => setTimeout(resolve, 6000));
        }
      } catch (error) {
        console.error(`Failed to send to ${recipient.email}:`, error.message);
        failedCount++;
        errors.push({ email: recipient.email, error: error.message });
        
        // Log failed send
        try {
          await db.query(
            'INSERT INTO email_send_log (recipient_email, send_type, success) VALUES ($1, $2, $3)',
            [recipient.email, 'bulk_email', false]
          );
        } catch (logError) {
          console.error('Failed to log email failure:', logError);
        }
      }
    }

    console.log(`📧 Bulk email sent by ${req.user.email}: ${sentCount} sent, ${failedCount} failed`);

    res.json({
      success: true,
      message: 'Bulk email sending completed',
      sent: sentCount,
      failed: failedCount,
      total: recipients.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error sending bulk email:', error);
    res.status(500).json({ error: 'Failed to send bulk email' });
  }
});

// Get recipient count preview
router.post('/preview', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const { eventIds } = req.body;

    if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ error: 'At least one event must be selected' });
    }

    const placeholders = eventIds.map((_, i) => `$${i + 1}`).join(', ');
    const query = `
      SELECT 
        e.name as event_name,
        t.event_id,
        COUNT(DISTINCT t.email) as count
      FROM tickets t
      LEFT JOIN events e ON t.event_id = e.id
      WHERE t.event_id IN (${placeholders})
      AND t.email IS NOT NULL
      AND t.email != ''
      AND (t.status IS NULL OR t.status = 'valid')
      GROUP BY t.event_id, e.name
    `;

    const result = await db.query(query, eventIds);
    
    const total = result.rows.reduce((sum, row) => sum + parseInt(row.count), 0);

    res.json({
      breakdown: result.rows,
      total: total
    });
  } catch (error) {
    console.error('Error getting recipient preview:', error);
    res.status(500).json({ error: 'Failed to get recipient preview' });
  }
});

module.exports = router;
