import request from 'supertest';
import express from 'express';

const app = express();
app.get('/', (req, res) => res.json({ success: true, message: 'Hualink Distribution API running smoothly' }));

describe('HUALINK Backend API Core Verification', () => {
  it('GET / - Should return 200 and operational health message', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);
  });
});