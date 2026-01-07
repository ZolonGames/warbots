// Auth state management for landing page

document.addEventListener('DOMContentLoaded', async () => {
  const loggedOutDiv = document.getElementById('logged-out');
  const loggedInDiv = document.getElementById('logged-in');
  const userNameSpan = document.getElementById('user-name');

  try {
    const response = await fetch('/auth/me');
    const data = await response.json();

    if (data.authenticated) {
      loggedOutDiv.style.display = 'none';
      loggedInDiv.style.display = 'block';
      userNameSpan.textContent = data.user.displayName;
    } else {
      loggedOutDiv.style.display = 'block';
      loggedInDiv.style.display = 'none';
    }
  } catch (error) {
    console.error('Failed to check auth status:', error);
    loggedOutDiv.style.display = 'block';
    loggedInDiv.style.display = 'none';
  }
});
