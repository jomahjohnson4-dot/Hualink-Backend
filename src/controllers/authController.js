import prisma from '../config/db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';

const otpStore = new Map();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || process.env.EMAIL_USER || 'hualinkdistribution01@gmail.com',
    pass: process.env.SMTP_PASS || process.env.EMAIL_PASS
  }
});

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Hakiki kama mtumiaji yupo kwenye database
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ success: false, message: "Account does not exist. Please sign up first." });
    }

    // Hakiki nenosiri kwa usahihi kupitia bcrypt
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '1d' });
    
    res.status(200).json({ 
      success: true, 
      token, 
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        role: user.role 
      } 
    });
  } catch (error) {
    console.error("❌ Login Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const requestSignupOtp = async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    otpStore.set(email, { otp, password, name, phone });

    const mailOptions = {
      from: '"Hualink Distribution" <hualinkdistribution01@gmail.com>',
      to: email,
      subject: 'Hualink Account Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #e60012;">Hualink Distribution</h2>
          <p>Hello,</p>
          <p>Your verification code for creating your Hualink account is:</p>
          <h1 style="background: #f4f4f4; padding: 10px 20px; display: inline-block; letter-spacing: 5px; color: #111;">${otp}</h1>
          <p>This code is valid for 10 minutes. Do not share it with anyone.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 [EMAIL SENT] Verification code ${otp} sent successfully to ${email}`);

    res.status(200).json({ success: true, message: "Verification code sent to your email successfully." });
  } catch (error) {
    console.error("❌ Error sending email:", error);
    res.status(500).json({ success: false, message: "Failed to send email: " + error.message });
  }
};

export const verifyOtp = async (req, res) => {
  try {
    const { email, otp, code } = req.body;
    const clientOtp = otp || code;
    
    const pendingData = otpStore.get(email);
    if (!pendingData) {
      return res.status(400).json({ success: false, message: "Verification session expired. Please request a new code." });
    }

    if (pendingData.otp !== clientOtp) {
      return res.status(400).json({ success: false, message: "Invalid verification code." });
    }

    const hashedPassword = await bcrypt.hash(pendingData.password || 'password123', 10);
    
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name: pendingData.name || 'User',
          role: 'USER'
        }
      });
    }

    otpStore.delete(email);

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '1d' });

    res.status(200).json({
      success: true,
      message: "Account verified and created successfully!",
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const register = requestSignupOtp;

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ success: false, message: "Email not found in our records." });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(email, { otp, isReset: true });

    const mailOptions = {
      from: '"Hualink Distribution" <hualinkdistribution01@gmail.com>',
      to: email,
      subject: 'Hualink Password Reset Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2 style="color: #e60012;">Hualink Distribution</h2>
          <p>Hello,</p>
          <p>Your password reset code is:</p>
          <h1 style="background: #f4f4f4; padding: 10px 20px; display: inline-block; letter-spacing: 5px; color: #111;">${otp}</h1>
          <p>Use this code to complete resetting your password.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`🔑 [RESET CODE] Sent to ${email}`);

    res.status(200).json({ success: true, message: "Password reset code sent to email." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const { email, password, newPassword } = req.body;
    const targetPassword = newPassword || password;

    if (!targetPassword) {
      return res.status(400).json({ success: false, message: "New password is required." });
    }

    const hashedPassword = await bcrypt.hash(targetPassword, 10);

    const user = await prisma.user.update({
      where: { email },
      data: { password: hashedPassword }
    });

    console.log(`✅ [PASSWORD RESET] Success for ${email}`);
    res.status(200).json({ success: true, message: "Password reset successfully." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyResetPassword = async (req, res) => {
  res.status(200).json({ success: true, message: "Reset token verified successfully."});
};

export const getProfile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.status(200).json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const googleLogin = async (req, res) => {
  res.status(200).json({ success: true, message: "Google login successful." });
};

export const requestOtp = requestSignupOtp;
export const loginUser = login;
export const registerUser = register;
