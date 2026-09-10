const { z } = require('zod');

/**
 * Validate req.body against a zod schema, replacing it with the parsed result.
 *
 * Registration previously accepted anything the client sent, including an
 * empty email and an empty password, and only failed later at the Mongoose
 * layer as an opaque 500.
 */
const validateBody = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      message: 'Invalid request',
      errors: result.error.issues.map((i) => ({
        field: i.path.join('.') || '(body)',
        message: i.message
      }))
    });
  }
  req.body = result.data;
  next();
};

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  // Matches the minlength already declared on the User model.
  password: z.string().min(6, 'Password must be at least 6 characters').max(200)
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required').max(200)
});

/** Shared ?limit=&page= parsing for list endpoints. */
function pagination(query, { defaultLimit = 100, maxLimit = 500 } = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
}

module.exports = { validateBody, registerSchema, loginSchema, pagination };
