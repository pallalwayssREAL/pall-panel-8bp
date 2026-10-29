exports.requireRole = (...roles) => (req, res, next) => {
  if (!req.session.admin) return res.redirect('/login');
  if (!roles.includes(req.session.admin.role)) return res.status(403).send('Akses ditolak');
  if (req.session.admin.must_change_password && req.path !== '/account/password') {
    return res.redirect('/account/password');
  }
  next();
};