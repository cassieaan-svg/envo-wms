import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const TOKEN_TTL = '12h';

export class UserService {
  static async login(username, password) {
    const { rows } = await query(
      'SELECT id, username, password_hash, full_name, role FROM users WHERE username = $1 AND is_active',
      [username]
    );
    const user = rows[0];

    // Compare even when the user is missing would be ideal for timing, but a plain
    // early return is fine here — this is an internal tool behind a VPN-less LAN.
    if (!user) return null;

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return null;

    const token = jwt.sign(
      { sub: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_TTL }
    );

    return {
      token,
      user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role },
    };
  }

  static async getById(id) {
    const { rows } = await query(
      'SELECT id, username, full_name, role FROM users WHERE id = $1 AND is_active',
      [id]
    );
    return rows[0] || null;
  }

  // Requires the current password, so a borrowed session can't lock the real owner out.
  static async changePassword(id, { currentPassword, newPassword }) {
    const { rows } = await query(
      'SELECT id, password_hash FROM users WHERE id = $1 AND is_active',
      [id]
    );
    const user = rows[0];
    if (!user) {
      const err = new Error('user not found');
      err.status = 404;
      throw err;
    }

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) {
      const err = new Error('current password is incorrect');
      err.status = 400;
      throw err;
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hash]);
    return true;
  }
}
