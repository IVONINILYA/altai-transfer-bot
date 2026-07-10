/* ========================================
   Алтай Трансфер — Telegram Mini App v7
   Flow: menu → routes → booking-form → drivers → success
   ======================================== */

var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
var selectedRoute = null;
var selectedDriver = null;
var bookingFormData = null;
var currentDriverId = '';
var currentScreenIndex = 0;
var calendarState = { year: 2026, month: 6, selectedDay: null, busyDays: {} };

// ── Payment state ────────────────────────────────────────────────────────────
var currentPaymentId = null;
var currentOrderId = null;
var paymentPollInterval = null;
var paymentStartTime = null;
var PAYMENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ── Fallback drivers (8 total) ──────────────────────────────────────────────
var FALLBACK_DRIVERS = [
  { id:'d1', name:'Алексей Петров', phone:'+79031234567', car:'Hyundai Solaris', year:2021, color:'Белый', rating:4.8, orders_count:124, photo_url:'/driver-alexey.jpg' },
  { id:'d2', name:'Иван Сидоров', phone:'+79032345678', car:'Kia Rio', year:2022, color:'Серебристый', rating:4.9, orders_count:89, photo_url:'/driver-ivan.jpg' },
  { id:'d3', name:'Мария Иванова', phone:'+79033456789', car:'Skoda Rapid', year:2020, color:'Чёрный', rating:5.0, orders_count:203, photo_url:'/driver-maria.jpg' },
  { id:'d4', name:'Нурбол Каирбеков', phone:'+79034567890', car:'Toyota Camry', year:2020, color:'Серебристый', rating:4.7, orders_count:67, photo_url:'/driver-nurbol.jpg' },
  { id:'d5', name:'Сергей Волков', phone:'+79035678901', car:'Volkswagen Polo', year:2023, color:'Синий', rating:4.6, orders_count:45, photo_url:'/driver-sergey.jpg' },
  { id:'d6', name:'Айгуль Токтосьнова', phone:'+79036789012', car:'Hyundai Creta', year:2022, color:'Белый', rating:4.9, orders_count:156, photo_url:'/driver-aigul.jpg' },
  { id:'d7', name:'Дмитрий Козлов', phone:'+79037890123', car:'Kia Seltos', year:2023, color:'Чёрный', rating:4.5, orders_count:34, photo_url:'/driver-dmitry.jpg' },
  { id:'d8', name:'Елена Смирнова', phone:'+79038901234', car:'Renault Duster', year:2021, color:'Красный', rating:4.8, orders_count:98, photo_url:'/driver-elena.jpg' }
];

// Fallback tg
if (!tg) {
  tg = { ready:function(){}, expand:function(){},
    themeParams:{bg_color:'#fff',text_color:'#000',hint_color:'#999',link_color:'#2481cc',button_color:'#2481cc',button_text_color:'#fff'},
    BackButton:{show:function(){},hide:function(){},onClick:function(){}},
    MainButton:{show:function(){},hide:function(){},setParams:function(){},onClick:function(){}},
    HapticFeedback:{impactOccurred:function(){},notificationOccurred:function(){}},
    initData:'', initDataUnsafe:{}, showPopup:function(){} };
}

// Restore state
try {
  currentDriverId = localStorage.getItem('driverId') || '';
  var sr = localStorage.getItem('selectedRoute');
  var sd = localStorage.getItem('selectedDriver');
  if (sr) selectedRoute = JSON.parse(sr);
  if (sd) selectedDriver = JSON.parse(sd);
  var bd = localStorage.getItem('busyDays');
  if (bd) calendarState.busyDays = JSON.parse(bd);
} catch(e) {}

// --- Init ---
document.addEventListener('DOMContentLoaded', function() {
  try {
    tg.ready(); tg.expand();
    applyTheme();

    // Add telegram-webview class for CSS fixes
    if (tg.platform) {
      document.body.classList.add('telegram-webview');
    }

    bindEvents();
    tg.BackButton.onClick(function(){ goBack(); });
    tg.BackButton.hide();
    console.log('[MiniApp] v7 initialized');

    // Check if returning from payment
    checkPaymentReturn();
  } catch (e) {
    console.error('[MiniApp] Init error:', e);
  }
});

/**
 * Check URL params when returning from payment page.
 */
function checkPaymentReturn() {
  try {
    var params = new URLSearchParams(window.location.search);
    var paymentId = params.get('payment');
    if (paymentId) {
      console.log('[Payment] Returning from payment, checking status...');
      // Remove payment param from URL
      var url = new URL(window.location.href);
      url.searchParams.delete('payment');
      window.history.replaceState({}, '', url.toString());
      // Check payment status
      currentPaymentId = paymentId;
      startPaymentPolling(paymentId);
    }
  } catch (e) {
    console.error('[Payment] checkPaymentReturn error:', e);
  }
}

function applyTheme() {
  try {
    var bg = tg.themeParams.bg_color || '#ffffff';
    document.body.style.backgroundColor = bg;
    var r = document.documentElement;
    r.style.setProperty('--tg-bg', bg);
    r.style.setProperty('--tg-text', tg.themeParams.text_color || '#000');
    r.style.setProperty('--tg-button', tg.themeParams.button_color || '#2481cc');
  } catch(e) {}
}

// === NAVIGATION (transform-based, NO display:none) ===
function showScreen(index) {
  currentScreenIndex = index;
  var pct = (index * 100) / 8;
  document.getElementById('screens-container').style.transform = 'translateX(-' + pct + '%)';

  if (index === 0) { tg.BackButton.hide(); }
  else { tg.BackButton.show(); }

  try { tg.HapticFeedback.impactOccurred('light'); } catch(e){}
  var ef = document.getElementById('error-fallback');
  if (ef) ef.style.display = 'none';
}

function goBack() {
  // New flow: menu(0) → routes(1) → form(2) → drivers(3) → success(4) → orders(5) → driver(6) → become-driver(7)
  var map = { 1:0, 2:1, 3:2, 4:0, 5:0, 6:0, 7:0 };
  showScreen(map[currentScreenIndex] || 0);
}

// === EVENT BINDING ===
function bindEvents() {
  // Menu
  document.getElementById('menu-book').addEventListener('click', function(){
    loadRoutes();
    showScreen(1);
  });
  document.getElementById('menu-orders').addEventListener('click', function(){
    loadOrders();
    showScreen(5);
  });
  document.getElementById('menu-become-driver').addEventListener('click', function(){
    showScreen(7);
  });
  document.getElementById('menu-driver').addEventListener('click', function(){
    showScreen(6);
    if (currentDriverId) { autoLoginDriver(); }
  });

  // Back buttons
  document.getElementById('btn-back-menu1').addEventListener('click', function(){ showScreen(0); });
  document.getElementById('btn-back-routes').addEventListener('click', function(){ showScreen(0); });
  document.getElementById('btn-back-form').addEventListener('click', function(){ showScreen(1); });
  document.getElementById('btn-back-drivers').addEventListener('click', function(){ showScreen(2); });
  document.getElementById('btn-back-menu2').addEventListener('click', function(){ showScreen(0); });
  document.getElementById('btn-back-menu3').addEventListener('click', function(){ showScreen(0); });
  document.getElementById('btn-back-become').addEventListener('click', function(){ showScreen(0); });

  // Success
  document.getElementById('btn-success-orders').addEventListener('click', function(){ loadOrders(); showScreen(5); });
  document.getElementById('btn-success-new').addEventListener('click', function(){ showScreen(0); });

  // Empty orders
  document.getElementById('btn-empty-book').addEventListener('click', function(){ showScreen(1); });

  // Booking form → show drivers (new flow)
  document.getElementById('booking-form').addEventListener('submit', function(e){
    e.preventDefault();
    saveBookingFormAndShowDrivers();
  });

  // Driver registration form
  document.getElementById('driver-reg-form').addEventListener('submit', function(e){
    e.preventDefault();
    submitDriverRegistration();
  });

  // Custom route
  document.getElementById('btn-custom-route').addEventListener('click', function(){
    var f = document.getElementById('custom-route-form');
    if (f) f.style.display = f.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btn-calc-custom').addEventListener('click', function(){
    var from = document.getElementById('custom-from').value;
    var to = document.getElementById('custom-to').value;
    var dist = calcDistance(from, to);
    var priceEl = document.getElementById('custom-price-result');
    var bookBtn = document.getElementById('btn-book-custom');
    if (!dist) {
      priceEl.textContent = 'Не удалось рассчитать. Попробуйте выбрать из списка.';
      priceEl.style.color = '#ff3b30';
      priceEl.style.display = 'block';
      bookBtn.style.display = 'none';
      return;
    }
    var price = calcPrice(dist);
    priceEl.innerHTML = '~' + dist + ' км · ' + fp(price) + ' ₽';
    priceEl.style.color = 'var(--tg-button)';
    priceEl.style.display = 'block';
    bookBtn.style.display = 'block';
    // Store custom route
    selectedRoute = { id:'custom_' + Date.now(), name: from + ' → ' + to, from_location: from, to_location: to, distance: dist, duration: '~' + Math.round(dist/60 + 0.5) + ' часа', price: price };
    try { localStorage.setItem('selectedRoute', JSON.stringify(selectedRoute)); } catch(e){}
  });
  document.getElementById('btn-book-custom').addEventListener('click', function(){
    if (!selectedRoute) { showError('Сначала рассчитайте цену'); return; }
    showBookingForm(selectedRoute);
    showScreen(2); // Show booking form for custom route
  });

  // Driver login
  document.getElementById('btn-login-driver').addEventListener('click', loginDriver);

  // Driver tabs
  document.querySelectorAll('.tab-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      var tab = this.getAttribute('data-tab');
      if (tab) showDriverTab(tab, this);
    });
  });

  // Calendar nav
  document.getElementById('cal-prev').addEventListener('click', function(){ changeMonth(-1); });
  document.getElementById('cal-next').addEventListener('click', function(){ changeMonth(1); });
}

// === DISTANCE MATRIX (km between locations on Chuya Highway) ===
var DISTANCES = {
  'Аэропорт Горно-Алтайск': { 'Горно-Алтайск': 5, 'Манжерок': 25, 'Усть-Сема': 52, 'Чемал': 80, 'Шебалино': 105, 'Семинский перевал': 125, 'Усть-Кан': 180, 'Усть-Кокса': 210, 'Онгудай': 195, 'Чике-Таман': 200, 'Иня': 265, 'Акташ': 330, 'Курай': 365, 'Кош-Агач': 435, 'Улаган': 380, 'Джазатор (Беляши)': 575, 'Телецкое озеро': 300 },
  'Горно-Алтайск':            { 'Аэропорт Горно-Алтайск': 5, 'Манжерок': 20, 'Чемал': 75, 'Онгудай': 190, 'Акташ': 325, 'Кош-Агач': 430 },
  'Манжерок':                 { 'Аэропорт Горно-Алтайск': 25, 'Горно-Алтайск': 20, 'Чемал': 55, 'Онгудай': 170, 'Акташ': 305, 'Кош-Агач': 410 },
  'Чемал':                    { 'Аэропорт Горно-Алтайск': 80, 'Горно-Алтайск': 75, 'Манжерок': 55, 'Телецкое озеро': 220, 'Онгудай': 120, 'Акташ': 260, 'Кош-Агач': 370 },
  'Онгудай':                  { 'Аэропорт Горно-Алтайск': 195, 'Чемал': 120, 'Акташ': 135, 'Кош-Агач': 240, 'Курай': 180, 'Улаган': 230 },
  'Усть-Кан':                 { 'Аэропорт Горно-Алтайск': 180, 'Усть-Кокса': 25, 'Онгудай': 50, 'Акташ': 175, 'Кош-Агач': 275 },
  'Усть-Кокса':               { 'Аэропорт Горно-Алтайск': 210, 'Усть-Кан': 25, 'Онгудай': 80, 'Акташ': 140, 'Кош-Агач': 240 },
  'Акташ':                    { 'Аэропорт Горно-Алтайск': 330, 'Чемал': 260, 'Онгудай': 135, 'Кош-Агач': 105, 'Курай': 40, 'Улаган': 50, 'Усть-Кан': 175, 'Усть-Кокса': 140 },
  'Кош-Агач':                 { 'Аэропорт Горно-Алтайск': 435, 'Чемал': 370, 'Онгудай': 240, 'Акташ': 105, 'Курай': 70, 'Джазатор (Беляши)': 140, 'Усть-Кан': 275, 'Усть-Кокса': 240 },
  'Улаган':                   { 'Аэропорт Горно-Алтайск': 380, 'Акташ': 50, 'Кош-Агач': 155, 'Онгудай': 185 },
  'Джазатор (Беляши)':        { 'Кош-Агач': 140, 'Аэропорт Горно-Алтайск': 575 },
  'Телецкое озеро':           { 'Аэропорт Горно-Алтайск': 300, 'Чемал': 220, 'Горно-Алтайск': 295 },
  'Курай':                    { 'Акташ': 40, 'Кош-Агач': 70, 'Аэропорт Горно-Алтайск': 365 },
};

function calcDistance(from, to) {
  if (!from || !to) return null;
  from = from.trim(); to = to.trim();
  if (from === to) return 0;
  // Direct distance
  if (DISTANCES[from] && DISTANCES[from][to]) return DISTANCES[from][to];
  if (DISTANCES[to] && DISTANCES[to][from]) return DISTANCES[to][from];
  // Try via airport as hub
  var d1 = DISTANCES[from] && DISTANCES[from]['Аэропорт Горно-Алтайск'];
  var d2 = DISTANCES[to] && DISTANCES[to]['Аэропорт Горно-Алтайск'];
  if (d1 && d2) return Math.abs(d1 - d2) + 10; // +10km buffer for non-highway segments
  return null;
}

function calcPrice(distance) {
  if (!distance || distance <= 0) return null;
  return Math.max(500, Math.round(distance * 30 / 50) * 50);
}

// === ROUTES (exact km from Chuya Highway, airport at km 459 from Novosibirsk) ===
// Price = distance × 30 RUB/km, min 500 RUB
function mkRoute(id, name, from, to, dist, duration, price) {
  return { id:id, name:name, from_location:from, to_location:to, distance:dist, duration:duration, price:price || Math.max(500, Math.round(dist * 30 / 50) * 50) };
}

var ALL_ROUTES = [
  mkRoute('r1',  'Аэропорт → Горно-Алтайск',    'Аэропорт Горно-Алтайск','Горно-Алтайск',     5,   '15 мин',      500),
  mkRoute('r2',  'Аэропорт → Манжерок',          'Аэропорт Горно-Алтайск','Манжерок',          25,  '30 мин',      750),
  mkRoute('r3',  'Аэропорт → Чемал',             'Аэропорт Горно-Алтайск','Чемал',             80,  '1.5 часа',    2400),
  mkRoute('r4',  'Аэропорт → Онгудай',           'Аэропорт Горно-Алтайск','Онгудай',           195, '3 часа',      5850),
  mkRoute('r5',  'Аэропорт → Усть-Кан',          'Аэропорт Горно-Алтайск','Усть-Кан',          180, '3 часа',      5400),
  mkRoute('r6',  'Аэропорт → Усть-Кокса',        'Аэропорт Горно-Алтайск','Усть-Кокса',        210, '3.5 часа',    6300),
  mkRoute('r7',  'Аэропорт → Акташ',             'Аэропорт Горно-Алтайск','Акташ',             330, '5 часов',     9900),
  mkRoute('r8',  'Аэропорт → Кош-Агач',          'Аэропорт Горно-Алтайск','Кош-Агач',          435, '6 часов',     13050),
  mkRoute('r9',  'Аэропорт → Улаган',            'Аэропорт Горно-Алтайск','Улаган',            380, '5.5 часов',   11400),
  mkRoute('r10', 'Аэропорт → Джазатор (Беляши)', 'Аэропорт Горно-Алтайск','Джазатор (Беляши)', 575, '8 часов',     17250),
  mkRoute('r11', 'Аэропорт → Телецкое озеро',    'Аэропорт Горно-Алтайск','Телецкое озеро',    300, '5.5 часов',   9000),
  mkRoute('r12', 'Горно-Алтайск → Чемал',        'Горно-Алтайск',         'Чемал',             75,  '1.5 часа',    2250),
  mkRoute('r13', 'Манжерок → Чемал',             'Манжерок',              'Чемал',             55,  '1 час',       1650),
  mkRoute('r14', 'Чемал → Телецкое озеро',       'Чемал',                 'Телецкое озеро',    220, '3.5 часа',    6600),
  mkRoute('r15', 'Кош-Агач → Джазатор',          'Кош-Агач',              'Джазатор',          140, '3 часа',      4200),
  mkRoute('r16', 'Онгудай → Акташ',              'Онгудай',               'Акташ',             135, '2.5 часа',    4050),
  mkRoute('r17', 'Кош-Агач → Онгудай',           'Кош-Агач',              'Онгудай',           240, '4 часа',      7200),
  mkRoute('r18', 'Акташ → Улаган',               'Акташ',                 'Улаган',            50,  '1 час',       1500),
];

function loadRoutes() {
  renderRoutes(ALL_ROUTES);
}

function renderRoutes(routes) {
  var c = document.getElementById('routes-list');
  if (!c) return;
  var html = '';
  routes.forEach(function(r){
    var info = r.from + ' → ' + r.to + ' · ' + r.distance + ' км · ' + r.duration;
    html += '<div class="route-card" data-rid="'+r.id+'">'+
      '<div class="route-name">'+esc(r.name)+'</div>'+
      '<div class="route-info">'+esc(info)+'</div>'+
      '<div class="route-price">'+fp(r.price)+' ₽</div></div>';
  });
  c.innerHTML = html;
  c.querySelectorAll('.route-card').forEach(function(card){
    card.addEventListener('click', function(){
      var rid = this.getAttribute('data-rid');
      var route = ALL_ROUTES.find(function(x){ return x.id === rid; });
      if (route) selectRoute(route);
    });
  });
}

function selectRoute(route) {
  selectedRoute = route;
  try { localStorage.setItem('selectedRoute', JSON.stringify(route)); } catch(e){}
  showBookingForm(route);
  showScreen(2); // screen-form is now index 2 (after routes)
}

// === DRIVERS ===
function loadDrivers() {
  fetch('/api/drivers')
    .then(function(r){ return r.json(); })
    .then(function(d){ renderDrivers(d); })
    .catch(function(e){
      // Fallback: 8 hardcoded drivers if API fails
      renderDrivers(FALLBACK_DRIVERS);
    });
}

function renderDrivers(drivers) {
  var c = document.getElementById('drivers-list');
  if (!c) return;
  var html = '';
  drivers.forEach(function(d){
    var initial = d.name ? d.name.charAt(0) : '?';
    var carInfo = (d.car||'') + (d.year?' · '+d.year:'') + (d.color?' · '+d.color:'');
    var avatar = d.photo_url
      ? '<img src="'+d.photo_url+'" class="driver-avatar-img" alt="">'
      : '<div class="driver-avatar-placeholder">'+esc(initial)+'</div>';
    html += '<div class="driver-card" data-did="'+d.id+'">'+avatar+
      '<div class="driver-info">'+
      '<div class="driver-name">'+esc(d.name)+'</div>'+
      '<div class="driver-car">'+esc(carInfo)+'</div>'+
      '<div class="driver-rating">★ '+(d.rating||'5.0')+'</div></div></div>';
  });
  c.innerHTML = html;
  c.querySelectorAll('.driver-card').forEach(function(card){
    card.addEventListener('click', function(){
      var did = this.getAttribute('data-did');
      var driver = drivers.find(function(x){ return x.id === did; });
      if (driver) selectDriver(driver);
    });
  });
}

function selectDriver(driver) {
  selectedDriver = driver;
  try { localStorage.setItem('selectedDriver', JSON.stringify(driver)); } catch(e){}
  // New flow: immediately submit order (form data already collected)
  submitOrder();
}

// === BOOKING FORM ===
function showBookingForm(route) {
  // Show route info in order summary
  var s = document.getElementById('order-summary');
  if (s) {
    s.innerHTML = '<div class="order-summary-route">'+esc(route.name)+'</div>'+
      '<div class="order-summary-price">'+fp(route.price)+' ₽</div>';
  }

  // Set default date/time values
  var tomorrow = new Date(Date.now()+86400000).toISOString().split('T')[0];
  var di = document.getElementById('booking-date');
  var ti = document.getElementById('booking-time');
  if (di) di.value = tomorrow;
  if (ti) ti.value = '12:00';
  var pi = document.getElementById('booking-passengers');
  var ci = document.getElementById('booking-comment');
  if (pi) pi.value = '1';
  if (ci) ci.value = '';
}

function saveBookingFormAndShowDrivers() {
  // Collect form data
  var date = document.getElementById('booking-date').value;
  var time = document.getElementById('booking-time').value;
  var passengers = document.getElementById('booking-passengers').value;
  var comment = document.getElementById('booking-comment').value;

  if (!date) { showError('Выберите дату поездки'); return; }
  if (!time) { showError('Выберите время поездки'); return; }

  bookingFormData = {
    date: date,
    time: time,
    passengers: parseInt(passengers) || 1,
    comment: comment
  };

  // Show drivers screen (index 3)
  loadDrivers();
  showScreen(3);
  var el = document.getElementById('drivers-route-name');
  if (el && selectedRoute) el.textContent = selectedRoute.name;
}

function submitOrder() {
  try {
    // Restore state if lost
    if (!selectedRoute) try { selectedRoute = JSON.parse(localStorage.getItem('selectedRoute')); } catch(e){}
    if (!selectedDriver) try { selectedDriver = JSON.parse(localStorage.getItem('selectedDriver')); } catch(e){}

    // Use booking form data collected earlier in the flow
    var date = bookingFormData ? bookingFormData.date : '';
    var time = bookingFormData ? bookingFormData.time : '';
    var passengers = bookingFormData ? bookingFormData.passengers : 1;
    var comment = bookingFormData ? bookingFormData.comment : '';

    console.log('[MiniApp] Submitting:', {date:date, time:time, passengers:passengers, route:selectedRoute ? selectedRoute.id : null, driver:selectedDriver ? selectedDriver.id : null});

    if (!date) { showError('Выберите дату поездки'); return; }
    if (!time) { showError('Выберите время поездки'); return; }
    if (!selectedRoute || !selectedDriver) { showError('Выберите маршрут и водителя (вернитесь назад)'); return; }

    var btn = document.getElementById('btn-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Отправка...'; }

    var body = {
      route_id: selectedRoute.id,
      driver_id: selectedDriver.id,
      date: date,
      time: time,
      passengers: parseInt(passengers) || 1,
      price: selectedRoute.price,
      comment: comment,
      initData: tg.initData || ''
    };

    fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function(r){
      if (!r.ok) {
        if (r.status === 401) throw new Error('Ошибка авторизации. Закройте Mini App и откройте заново.');
        return r.json().then(function(d){ throw new Error(d.error || 'Ошибка '+r.status); });
      }
      return r.json();
    })
    .then(function(order){
      if (btn) { btn.disabled = false; btn.innerHTML = 'Забронировать — <span id="form-price">0 ₽</span>'; }
      var sd = document.getElementById('success-details');
      if (sd) sd.innerHTML = 'Заказ №'+(order.id||'-')+'<br>'+esc(selectedRoute.name)+'<br>'+fd(date)+' в '+time;

      // Initiate payment flow after order creation
      var orderPrice = order.price || (selectedRoute ? selectedRoute.price : 0);
      var orderDesc = 'Заказ #' + order.id + ' — ' + (selectedRoute ? selectedRoute.name : 'Алтай Трансфер');
      initiatePaymentForOrder({ id: order.id, price: orderPrice, route_name: selectedRoute ? selectedRoute.name : '' });

      // Also show success screen (user can pay later from orders list)
      showScreen(4);
      try { tg.HapticFeedback.notificationOccurred('success'); } catch(e){}
    })
    .catch(function(e){
      console.error('[MiniApp] Order error:', e);
      if (btn) { btn.disabled = false; btn.innerHTML = 'Забронировать — <span id="form-price">0 ₽</span>'; }
      showError(e.message || 'Не удалось создать заказ');
    });
  } catch (e) {
    console.error('[MiniApp] submitOrder error:', e);
    showError('Ошибка: ' + e.message);
  }
}

// === ORDERS ===
function loadOrders() {
  var c = document.getElementById('orders-list');
  var e = document.getElementById('orders-empty');
  if (c) c.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';

  var initData = tg.initData || '';
  if (!initData) {
    if (c) c.innerHTML = '';
    if (e) e.style.display = 'block';
    return;
  }

  fetch('/api/orders?initData=' + encodeURIComponent(initData))
    .then(function(r){ return r.json(); })
    .then(function(orders){ renderOrders(orders); })
    .catch(function(err){
      console.error('[MiniApp] Orders error:', err);
      if (c) c.innerHTML = '';
      if (e) e.style.display = 'block';
    });
}

function renderOrders(orders) {
  var c = document.getElementById('orders-list');
  var e = document.getElementById('orders-empty');
  if (!orders || orders.length === 0) {
    if (c) c.innerHTML = '';
    if (e) e.style.display = 'block';
    return;
  }
  if (e) e.style.display = 'none';
  var html = '';
  orders.forEach(function(o){
    var sc = 'status-' + (o.status || 'pending').toLowerCase();
    html += '<div class="order-card">'+
      '<div class="order-route">'+esc(o.route_name || 'Маршрут')+'</div>'+
      '<div class="order-meta">'+(o.date ? fd(o.date) : '')+' в '+(o.time || '--:--')+' · '+(o.driver_name || '')+'</div>'+
      '<span class="order-status '+sc+'">'+gst(o.status)+'</span>'+
      '<div class="order-price">'+fp(o.price)+' ₽</div></div>';
  });
  if (c) c.innerHTML = html;
}

// === DRIVER DASHBOARD ===
function autoLoginDriver() {
  document.getElementById('driver-auth').style.display = 'none';
  document.getElementById('driver-content').style.display = 'block';
  loadDriverOrders('PENDING');
  loadCalendarFromServer(); // Load from server instead of local render
}

function loginDriver() {
  var id = document.getElementById('driver-id-input').value.trim();
  if (!id) { showError('Введите ID водителя'); return; }
  currentDriverId = id;
  try { localStorage.setItem('driverId', id); } catch(e){}
  autoLoginDriver();
}

function showDriverTab(tab, btn) {
  var tabs = btn.closest('.driver-tabs');
  if (tabs) tabs.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('#screen-driver .tab-content').forEach(function(c){ c.classList.remove('active'); });
  var content = document.getElementById('tab-' + tab);
  if (content) content.classList.add('active');

  if (tab === 'incoming') loadDriverOrders('PENDING');
  else if (tab === 'active') loadDriverOrders('CONFIRMED');
  else if (tab === 'calendar') loadCalendarFromServer(); // Load from server
}

function loadDriverOrders(statusFilter) {
  if (!currentDriverId) return;
  var url = '/api/driver/orders?driver_id=' + encodeURIComponent(currentDriverId);
  if (statusFilter) url += '&status=' + statusFilter;

  var containerId = statusFilter === 'PENDING' ? 'incoming-list' : 'active-list';
  var emptyId = statusFilter === 'PENDING' ? 'incoming-empty' : 'active-empty';
  var showActions = statusFilter === 'PENDING';

  fetch(url)
    .then(function(r){ return r.json(); })
    .then(function(orders){ renderDriverOrders(orders, containerId, emptyId, showActions); })
    .catch(function(e){
      var c = document.getElementById(containerId);
      var emp = document.getElementById(emptyId);
      if (c) c.innerHTML = '';
      if (emp) emp.style.display = 'block';
    });
}

function renderDriverOrders(orders, containerId, emptyId, showActions) {
  var c = document.getElementById(containerId);
  var emp = document.getElementById(emptyId);
  if (!orders || orders.length === 0) {
    if (c) c.innerHTML = '';
    if (emp) emp.style.display = 'block';
    return;
  }
  if (emp) emp.style.display = 'none';
  var html = '';
  orders.forEach(function(o){
    var sc = 'status-' + (o.status || 'pending').toLowerCase();
    var actions = '';
    if (showActions && o.status === 'PENDING') {
      actions = '<div class="order-actions">'+
        '<button class="btn-confirm" data-oid="'+o.id+'" data-st="CONFIRMED">Принять</button>'+
        '<button class="btn-cancel" data-oid="'+o.id+'" data-st="CANCELLED">Отклонить</button></div>';
    } else if (o.status === 'CONFIRMED') {
      actions = '<div class="order-actions">'+
        '<button class="btn-complete" data-oid="'+o.id+'" data-st="COMPLETED">Завершить</button></div>';
    }
    html += '<div class="order-card">'+
      '<div class="order-route">'+esc(o.route_name || 'Маршрут')+'</div>'+
      '<div class="order-meta">'+fd(o.date)+' в '+(o.time||'--:--')+' · '+(o.passengers||1)+' чел.</div>'+
      '<div class="order-meta">Пассажир: '+esc(o.user_name||'—')+'</div>'+
      '<span class="order-status '+sc+'">'+gst(o.status)+'</span>'+
      '<div class="order-price">'+fp(o.price)+' ₽</div>'+actions+'</div>';
  });
  if (c) c.innerHTML = html;
  c.querySelectorAll('.btn-confirm, .btn-cancel, .btn-complete').forEach(function(btn){
    btn.addEventListener('click', function(){
      updateOrderStatus(this.getAttribute('data-oid'), this.getAttribute('data-st'));
    });
  });
}

function updateOrderStatus(oid, status) {
  fetch('/api/driver/orders/' + oid + '/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status })
  })
  .then(function(r){ return r.json(); })
  .then(function(){
    var activeTab = document.querySelector('#screen-driver .tab-btn.active');
    if (activeTab) {
      var tab = activeTab.getAttribute('data-tab');
      if (tab === 'incoming') loadDriverOrders('PENDING');
      else if (tab === 'active') loadDriverOrders('CONFIRMED');
    }
  })
  .catch(function(e){ showError('Ошибка обновления'); });
}

// === CALENDAR ===
function changeMonth(delta) {
  calendarState.month += delta;
  if (calendarState.month > 11) { calendarState.month = 0; calendarState.year++; }
  if (calendarState.month < 0) { calendarState.month = 11; calendarState.year--; }
  loadCalendarFromServer();
}

function loadCalendarFromServer() {
  if (!currentDriverId) return;
  var month = calendarState.year + '-' + String(calendarState.month+1).padStart(2,'0');
  fetch('/api/driver/calendar?driver_id=' + encodeURIComponent(currentDriverId) + '&month=' + month)
    .then(function(r) { return r.json(); })
    .then(function(days) {
      calendarState.busyDays = {}; // Clear before loading from server
      days.forEach(function(d) { calendarState.busyDays[d.date] = true; });
      renderCalendar();
    })
    .catch(function(e) {
      console.error('[MiniApp] Calendar load error:', e);
      renderCalendar();
    });
}

function toggleCalendarDay(dateKey) {
  if (!currentDriverId) return;
  var isBusy = !calendarState.busyDays[dateKey];
  fetch('/api/driver/calendar', {
    method: isBusy ? 'POST' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driver_id: currentDriverId, date: dateKey })
  })
  .then(function() { loadCalendarFromServer(); })
  .catch(function(e) { console.error('[MiniApp] Calendar toggle error:', e); });
}

function renderCalendar() {
  var grid = document.getElementById('cal-grid');
  var label = document.getElementById('cal-month');
  if (!grid || !label) return;

  var months = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  label.textContent = months[calendarState.month] + ' ' + calendarState.year;

  var firstDay = new Date(calendarState.year, calendarState.month, 1).getDay();
  var daysInMonth = new Date(calendarState.year, calendarState.month + 1, 0).getDate();
  firstDay = firstDay === 0 ? 6 : firstDay - 1; // Monday start

  var html = '';
  var dayLabels = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  dayLabels.forEach(function(d){ html += '<div class="cal-day-label">'+d+'</div>'; });

  for (var i = 0; i < firstDay; i++) html += '<div></div>';

  var today = new Date();
  for (var d = 1; d <= daysInMonth; d++) {
    var dateKey = calendarState.year + '-' + String(calendarState.month+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    var isToday = (d === today.getDate() && calendarState.month === today.getMonth() && calendarState.year === today.getFullYear());
    var isPast = new Date(calendarState.year, calendarState.month, d) < new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var isBusy = calendarState.busyDays[dateKey];
    var isSelected = calendarState.selectedDay === dateKey;

    var cls = 'cal-day';
    if (isSelected) cls += ' selected';
    else if (isBusy) cls += ' busy';
    else if (isToday) cls += ' today';
    if (isPast) cls += ' past';

    html += '<button class="'+cls+'" data-date="'+dateKey+'" '+(isPast?'disabled':'')+'>'+d+'</button>';
  }
  grid.innerHTML = html;

  // Use server sync for calendar day toggles
  grid.querySelectorAll('.cal-day:not(.past)').forEach(function(btn){
    btn.addEventListener('click', function(){
      var dateKey = this.getAttribute('data-date');
      calendarState.selectedDay = dateKey;
      toggleCalendarDay(dateKey);
    });
  });
}

// === DRIVER REGISTRATION ===
function submitDriverRegistration() {
  try {
    var name = document.getElementById('reg-name').value.trim();
    var phone = document.getElementById('reg-phone').value.trim();
    var car = document.getElementById('reg-car').value.trim();
    var year = document.getElementById('reg-year').value;
    var color = document.getElementById('reg-color').value.trim();
    var region = document.getElementById('reg-region').value;
    var bio = document.getElementById('reg-bio').value.trim();

    if (!name || !phone || !car || !year || !color || !region) {
      showError('Заполните все обязательные поля');
      return;
    }

    var btn = document.getElementById('btn-reg-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Отправка...'; }

    fetch('/api/drivers/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name:name, phone:phone, car:car, year:year, color:color, region:region, bio:bio, initData:tg.initData })
    })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d){ throw new Error(d.error || 'Ошибка '+r.status); });
      return r.json();
    })
    .then(function(data) {
      if (btn) { btn.disabled = false; btn.textContent = 'Отправить заявку'; }
      // Show success
      var sd = document.getElementById('success-details');
      if (sd) sd.innerHTML = 'Заявка на регистрацию водителя отправлена!<br>Ваш ID: ' + esc(data.driver_id || '—') + '<br>Ожидайте SMS в течение 24 часов.';
      showScreen(4);
      try { tg.HapticFeedback.notificationOccurred('success'); } catch(e){}
      // Clear form
      document.getElementById('driver-reg-form').reset();
    })
    .catch(function(e) {
      console.error('[MiniApp] Driver reg error:', e);
      if (btn) { btn.disabled = false; btn.textContent = 'Отправить заявку'; }
      showError(e.message || 'Не удалось отправить заявку');
    });
  } catch (e) {
    console.error('[MiniApp] submitDriverRegistration error:', e);
    showError('Ошибка: ' + e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  PAYMENTS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create a payment after order is created.
 * Called from submitOrder flow or can be called independently.
 */
function createPayment(orderId, amount, description) {
  return new Promise(function(resolve, reject) {
    var btn = document.getElementById('btn-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Создание платежа...'; }

    var body = {
      order_id: String(orderId),
      amount: amount,
      description: description || ('Заказ #' + orderId + ' — Алтай Трансфер'),
      return_url: window.location.href.split('?')[0] + '?payment=' + orderId
    };

    fetch('/api/payments/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function(r){
      if (!r.ok) return r.json().then(function(d){ throw new Error(d.error || 'Ошибка ' + r.status); });
      return r.json();
    })
    .then(function(data){
      currentPaymentId = data.payment_id;
      currentOrderId = orderId;

      if (btn) { btn.disabled = false; btn.innerHTML = 'Забронировать — <span id="form-price">0 ₽</span>'; }

      // Show payment UI with button to open payment URL
      showPaymentUI(data);
      resolve(data);
    })
    .catch(function(err){
      if (btn) { btn.disabled = false; btn.innerHTML = 'Забронировать — <span id="form-price">0 ₽</span>'; }
      showError(err.message || 'Не удалось создать платёж');
      reject(err);
    });
  });
}

/**
 * Show payment UI overlay with "Pay" button and test card info.
 */
function showPaymentUI(paymentData) {
  // Build payment overlay HTML
  var overlay = document.getElementById('payment-overlay');
  if (!overlay) {
    // Create overlay if not exists
    overlay = document.createElement('div');
    overlay.id = 'payment-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';

  var isTest = paymentData.test || false;
  overlay.innerHTML =
    '<div style="background:#fff;border-radius:16px;padding:20px;max-width:380px;width:100%;max-height:90vh;overflow-y:auto;">' +
      '<div style="text-align:center;margin-bottom:16px;">' +
        '<div style="font-size:18px;font-weight:700;margin-bottom:4px;">Оплата заказа</div>' +
        '<div style="font-size:14px;color:#888;">Заказ #' + esc(currentOrderId) + '</div>' +
        (isTest ? '<div style="display:inline-block;margin-top:8px;padding:3px 10px;border-radius:8px;background:#fff3cd;color:#856404;font-size:11px;font-weight:600;">ТЕСТОВЫЙ РЕЖИМ</div>' : '') +
      '</div>' +
      '<div style="background:#f8f9fa;border-radius:12px;padding:16px;margin-bottom:16px;text-align:center;">' +
        '<div style="font-size:28px;font-weight:700;color:#1a1a1a;">' + (paymentData.amount ? paymentData.amount.value : '—') + ' ₽</div>' +
        '<div style="font-size:12px;color:#888;margin-top:4px;">Сумма к оплате</div>' +
      '</div>' +
      (isTest ? '<div style="background:#f0f9ff;border:1px solid #bee5f3;border-radius:8px;padding:12px;margin-bottom:16px;font-size:12px;">' +
        '<div style="font-weight:600;margin-bottom:6px;color:#0c5460;">Тестовая карта</div>' +
        '<div style="display:flex;justify-content:space-between;padding:2px 0;">' +
          '<span style="color:#666;">Номер</span>' +
          '<span style="font-family:monospace;font-weight:500;">5555 5555 5555 4477</span></div>' +
        '<div style="display:flex;justify-content:space-between;padding:2px 0;">' +
          '<span style="color:#666;">Срок</span><span>Любая дата в будущем</span></div>' +
        '<div style="display:flex;justify-content:space-between;padding:2px 0;">' +
          '<span style="color:#666;">CVV</span><span style="font-family:monospace;">123</span></div>' +
        '<div style="display:flex;justify-content:space-between;padding:2px 0;">' +
          '<span style="color:#666;">Код 3DS</span><span style="font-family:monospace;">12345678</span></div>' +
      '</div>' : '') +
      '<button id="btn-pay-now" style="width:100%;padding:14px;border:none;border-radius:10px;background:linear-gradient(135deg,#2481cc,#1a6db5);color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:8px;-webkit-appearance:none;">' +
        'Перейти к оплате' +
      '</button>' +
      '<button id="btn-pay-cancel" style="width:100%;padding:12px;border:none;border-radius:10px;background:#f5f6f8;color:#666;font-size:14px;cursor:pointer;-webkit-appearance:none;">' +
        'Оплачу позже' +
      '</button>' +
      '<div id="payment-status" style="text-align:center;margin-top:12px;font-size:13px;color:#888;display:none;">' +
        '<div style="display:inline-block;width:14px;height:14px;border:2px solid #ddd;border-top-color:#2481cc;border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;margin-right:6px;"></div>' +
        'Проверка статуса...' +
      '</div>' +
    '</div>';

  // Add spin animation
  if (!document.getElementById('spin-style')) {
    var st = document.createElement('style');
    st.id = 'spin-style';
    st.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
  }

  document.getElementById('btn-pay-now').addEventListener('click', function(){
    if (paymentData.payment_url) {
      // Open payment URL
      if (tg && tg.openLink) {
        tg.openLink(paymentData.payment_url, { try_instant_view: false });
      } else {
        window.open(paymentData.payment_url, '_blank');
      }
      // Start polling for status
      startPaymentPolling(paymentData.payment_id);
    }
  });

  document.getElementById('btn-pay-cancel').addEventListener('click', hidePaymentOverlay);
}

function hidePaymentOverlay() {
  var overlay = document.getElementById('payment-overlay');
  if (overlay) overlay.style.display = 'none';
  stopPaymentPolling();
}

function startPaymentPolling(paymentId) {
  stopPaymentPolling();
  paymentStartTime = Date.now();

  var statusEl = document.getElementById('payment-status');
  if (statusEl) statusEl.style.display = 'block';

  // Poll every 3 seconds
  paymentPollInterval = setInterval(function(){
    // Timeout check
    if (Date.now() - paymentStartTime > PAYMENT_TIMEOUT_MS) {
      stopPaymentPolling();
      showError('Время оплаты истекло. Попробуйте снова.');
      hidePaymentOverlay();
      return;
    }

    checkPaymentStatus(paymentId);
  }, 3000);

  // Immediate first check
  checkPaymentStatus(paymentId);
}

function stopPaymentPolling() {
  if (paymentPollInterval) {
    clearInterval(paymentPollInterval);
    paymentPollInterval = null;
  }
}

/**
 * Check payment status and update UI accordingly.
 */
function checkPaymentStatus(paymentId) {
  if (!paymentId) paymentId = currentPaymentId;
  if (!paymentId) return;

  fetch('/api/payments/' + encodeURIComponent(paymentId) + '/status')
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.status === 'succeeded') {
        stopPaymentPolling();
        hidePaymentOverlay();
        // Show success screen
        showScreen(4);
        try { tg.HapticFeedback.notificationOccurred('success'); } catch(e){}
        // Show payment success popup
        try {
          tg.showPopup({ title: 'Оплачено!', message: 'Ваш заказ успешно оплачен. Водитель скоро свяжется с вами.' });
        } catch(e) {}
      } else if (data.status === 'canceled') {
        stopPaymentPolling();
        hidePaymentOverlay();
        showError('Платёж был отменён');
      }
      // If pending — continue polling
    })
    .catch(function(err){
      console.error('[Payment] Status check error:', err);
    });
}

/**
 * Initiate payment flow after order creation.
 * Integrates with existing submitOrder flow.
 */
function initiatePaymentForOrder(order) {
  var orderId = order.id;
  var amount = order.price || (selectedRoute ? selectedRoute.price : 0);
  var description = 'Заказ #' + orderId + ' — ' + (order.route_name || 'Алтай Трансфер');

  createPayment(orderId, amount, description)
    .then(function(paymentData){
      console.log('[Payment] Payment created:', paymentData);
    })
    .catch(function(err){
      console.error('[Payment] Payment failed:', err);
      // Still show success screen — user can pay later
      showScreen(4);
    });
}

// === UTILS ===
function esc(t) { if (!t) return ''; var d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; }
function fp(p) { if (!p && p !== 0) return '0'; return Number(p).toLocaleString('ru-RU'); }
function fd(s) { if (!s) return ''; var p = s.split('-'); if (p.length === 3) return p[2]+'.'+p[1]+'.'+p[0]; return s; }
function gst(s) { var m = {'PENDING':'Ожидает','CONFIRMED':'Подтверждён','COMPLETED':'Выполнен','CANCELLED':'Отменён'}; return m[s] || s || 'Ожидает'; }

function showError(msg) {
  console.error('[MiniApp]', msg);
  var ef = document.getElementById('error-fallback');
  var em = document.getElementById('error-message');
  if (ef && em) { em.textContent = msg; ef.style.display = 'block'; setTimeout(function(){ ef.style.display = 'none'; }, 5000); }
  try { tg.showPopup({ title: 'Ошибка', message: msg }); } catch(e){}
}

window.onerror = function(m, s, l) { showError('Ошибка: ' + m + ' (строка ' + l + ')'); return false; };
window.addEventListener('unhandledrejection', function(ev) { showError('Ошибка: ' + (ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason))); });
