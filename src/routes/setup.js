import express from 'express';

export function createSetupRouter({
  getConnectionStatus,
  onConnect,
  onDisconnect,
} = {}) {
  const router = express.Router();

  router.get('/status', async (req, res) => {
    try {
      const status = await getConnectionStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const status = await getConnectionStatus();
      res.render('setup-form', {
        title: 'Connect Yahoo Mail',
        status,
        form: {
          yahooEmail: '',
        },
        setupState: String(req.query.setup_state || ''),
        errorMessage: '',
        successMessage: req.query.connected ? 'Yahoo Mail connected successfully.' : '',
        disconnectedMessage: req.query.disconnected ? 'Yahoo Mail connection removed.' : '',
      });
    } catch (error) {
      res.render('setup-form', {
        title: 'Connect Yahoo Mail',
        status: { isConnected: false, status: 'error', maskedEmail: '', lastVerifiedAt: null },
        form: { yahooEmail: '' },
        setupState: String(req.query.setup_state || ''),
        errorMessage: error.message,
        successMessage: '',
        disconnectedMessage: '',
      });
    }
  });

  router.post('/connect', async (req, res) => {
    const yahooEmail = String(req.body?.yahooEmail || '').trim();
    const appPassword = String(req.body?.appPassword || '').trim();
    const setupState = String(req.body?.setupState || '').trim();

    if (!yahooEmail || !appPassword) {
      const status = await getConnectionStatus().catch(() => ({ isConnected: false, status: 'not_connected', maskedEmail: '', lastVerifiedAt: null }));
      return res.status(400).render('setup-form', {
        title: 'Connect Yahoo Mail',
        status,
        form: { yahooEmail },
        setupState,
        errorMessage: 'Yahoo email and app password are both required.',
        successMessage: '',
        disconnectedMessage: '',
      });
    }

    try {
      const redirectUrl = await onConnect({ yahooEmail, appPassword, setupState });
      if (redirectUrl) {
        return res.redirect(redirectUrl);
      }
      return res.redirect('/setup?connected=1');
    } catch (error) {
      const status = await getConnectionStatus().catch(() => ({ isConnected: false, status: 'not_connected', maskedEmail: '', lastVerifiedAt: null }));
      return res.status(400).render('setup-form', {
        title: 'Connect Yahoo Mail',
        status,
        form: { yahooEmail },
        setupState,
        errorMessage: error.message,
        successMessage: '',
        disconnectedMessage: '',
      });
    }
  });

  router.post('/disconnect', async (req, res) => {
    try {
      await onDisconnect();
      return res.redirect('/setup?disconnected=1');
    } catch (error) {
      const status = await getConnectionStatus().catch(() => ({ isConnected: false, status: 'not_connected', maskedEmail: '', lastVerifiedAt: null }));
      return res.status(500).render('setup-form', {
        title: 'Connect Yahoo Mail',
        status,
        form: { yahooEmail: '' },
        setupState: '',
        errorMessage: error.message,
        successMessage: '',
        disconnectedMessage: '',
      });
    }
  });

  return router;
}
