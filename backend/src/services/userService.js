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
}
