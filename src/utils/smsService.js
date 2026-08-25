import axios from 'axios';

/**
 * Format phone numbers to 2557XXXXXXXX format required by NextSMS
 */
const formatPhoneNumber = (phone) => {
  let cleaned = String(phone).replace(/\D/g, ''); // Remove non-digit characters
  if (cleaned.startsWith('0')) {
    cleaned = '255' + cleaned.slice(1);
  } else if (cleaned.startsWith('+255')) {
    cleaned = cleaned.replace('+', '');
  }
  return cleaned;
};

/**
 * Send SMS using NextSMS API
 */
export const sendSMS = async (to, message) => {
  const formattedPhone = formatPhoneNumber(to);
  const username = process.env.NEXTSMS_USERNAME;
  const password = process.env.NEXTSMS_PASSWORD;

  // Fallback log for development if credentials are missing
  if (!username || !password) {
    console.log(`[DEV SMS MOCK] To: ${formattedPhone} | Message: ${message}`);
    return { success: true, mock: true };
  }

  // Create Base64 Auth Header
  const authToken = Buffer.from(`${username}:${password}`).toString('base64');

  try {
    const response = await axios.post(
      'https://messaging-service.co.tz/api/sms/v1/text/single',
      {
        from: process.env.NEXTSMS_SENDER_ID || 'NEXTSMS',
        to: formattedPhone,
        text: message
      },
      {
        headers: {
          'Authorization': `Basic ${authToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    console.log(`SMS successfully sent to ${formattedPhone}`);
    return response.data;
  } catch (error) {
    console.error('NextSMS Delivery Failed:', error.response?.data || error.message);
    // Return null without breaking order flow
    return null;
  }
};