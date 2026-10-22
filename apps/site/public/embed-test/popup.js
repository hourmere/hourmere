// Both scripts are deferred, so the documented widget loader runs before this bootstrap.
const button = document.querySelector('#open-booking-popup')
const widgetStatus = document.querySelector('#widget-status')
const ready = Boolean(window.Hourmere)

button?.toggleAttribute('disabled', !ready)
if (widgetStatus)
  widgetStatus.textContent = ready
    ? ''
    : 'Booking widget could not load. Reload this page to try again.'

button?.addEventListener('click', () => {
  window.Hourmere?.openPopup({
    url: 'https://app.hourmere.com/adrian-lee/30-minute-call',
  })
})
