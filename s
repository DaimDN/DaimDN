const axios = require('axios');
const tough = require('tough-cookie');
const axiosCookieJarSupport = require('axios-cookiejar-support').default;

axiosCookieJarSupport(axios);

const cookieJar = new tough.CookieJar();

async function confluenceLoginAndGet() {
  // Login URL for Confluence Server (adjust if needed)
  const loginUrl = 'https://your-domain.net/confluence/dologin.action';

  // Login form data (usually username and password keys)
  const loginData = new URLSearchParams();
  loginData.append('os_username', 'your-username');
  loginData.append('os_password', 'your-password');
  loginData.append('login', 'Log In');

  try {
    // Perform login POST request, store cookies automatically
    await axios.post(loginUrl, loginData.toString(), {
      jar: cookieJar,
      withCredentials: true,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    // Now cookies are stored in cookieJar, make a GET request with those cookies
    const response = await axios.get(
      'https://your-domain.net/confluence/rest/api/content?spaceKey=GTS&type=page&limit=5',
      {
        jar: cookieJar,
        withCredentials: true
      }
    );

    console.log(response.data);
  } catch (error) {
    console.error('Error:', error);
  }
}

confluenceLoginAndGet();
