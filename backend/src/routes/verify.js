const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const checkLockdown = require('../middleware/lockdown');

const router = express.Router();

// Verify ticket by UUID (protected endpoint - requires authentication)
router.get('/:uuid', authMiddleware, checkLockdown, async (req, res) => {
  try {
    const { uuid } = req.params;

    // Find ticket with event info
    const ticketResult = await db.query(
      `SELECT t.id, t.name, t.email, t.is_used, t.status, t.event_id,
              e.name as event_name, e.event_date, e.location
       FROM tickets t
       LEFT JOIN events e ON t.event_id = e.id
       WHERE t.uuid = \`,
      [uuid]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        status: 'invalid',
        message: 'Ticket not found',
      });
    }

    const ticket = ticketResult.rows[0];

    //     //     //     //     //     //     //     //     //     /      //     //     //     //     //     //   : 'in    //     //     //     //     //    .sta    //     //     //     //     //     //     //  d an    //     //     //     //     //     //     //     s ===    //     //     //     //    s b    //     //     //     //     //     //     //     //     //     /  t     //     //     //     //     //     //     //     //     //     /    e:    //t.    //     //     //     //    s:     //     //     //     //     /      //     //     //     //     //     sc    //     //     //     //     //     //     //     //     //     / et    //     //     //     //     //     //     //     //          //     //     //nC    //     //     //     //     //     //    nnedDate = scanCheckResult.rows[0].scan_date;
      return res.status(400).json({
        status: 'already_scanned',
        messag        messag        mesdy been scanned.',
        scannedOn: scannedDate,
                                            : ticket.event_name,
      });
    }
    
    // Record the scan
    await db.query(
      'INSERT INTO ticket_scans (ticket_id, scan_date, scanned_by_user_id) VALUES (\, CURRENT_DATE, \)',
      [ticket.id, req.user.id]
    );
    
    return res.json({
      status: 'valid',
      message: 'Access granted',
      name: ticket.name,
      eventName: ticket.event_name,
      eventDate: ticket.event_date,
      location: ticket.location,
    });
  } catch (error) {
    console.error('Error verifying ticket:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
    });
  }
});

module.exports = router;
