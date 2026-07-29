/* ========================================
   Алтай Трансфер — Telegram Mini App v8
   Architecture: position:absolute + z-index + visibility
   NO transform, NO pointer-events
   ======================================== */

var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
var selectedRoute = null;
var selectedDriver = null;
var bookingFormData = null;
var currentDriverId = '';
var calendarState = { year: 2026, month: 6, selectedDay: null, busyDays: {} };

// ── Payment state ────────────────────────────────────────────────────────────
var currentPaymentId = null;
var currentOrderId = null;
var paymentPollInterval = null;
var paymentStartTime = null;
var PAYMENT_TIMEOUT_MS = 10 * 60 * 1000;

// ── Fallback drivers (8 total) ──────────────────────────────────────────────
var ALL_DRIVERS = [
  { id:'d1', name:'Алексей Петров', phone:'+79031234567', car:'Hyundai Solaris', year:2021, color:'Белый', rating:4.8, orders_count:124, photo_url:'/driver-alexey.jpg' },
  { id:'d2', name:'Иван Сидоров', phone:'+79032345678', car:'Kia Rio', year:2022, color:'Серебристый', rating:4.9, orders_count:89, photo_url:'/driver-ivan.jpg' },
  { id:'d3', name:'Мария Иванова', phone:'+79033456789', car:'Skoda Rapid', year:2020, color:'Чёрный', rating:5.0, orders_count:203, photo_url:'/driver-maria.jpg' },
  { id:'d4', name:'Нурбол Каирбеков', phone:'+79034567890', car:'Toyota Camry', year:2020, color:'Серебристый', rating:4.7, orders_count:67, photo_url:'/driver-nurbol.jpg' },
  { id:'d5', name:'Ольга Петрова', phone:'+79035678901', car:'Volkswagen Polo', year:2022, color:'Белый', rating:4.9, orders_count:112, photo_url:'/driver-olga.jpg' },
  { id:'d6', name:'Сергей Алтынбеков', phone:'+79036789012', car:'UAZ Patriot', year:2021, color:'Зелёный', rating:4.6, orders_count:89, photo_url:'/driver-sergey.jpg' },
  { id:'d7', name:'Дмитрий Соколов', phone:'+79037890123', car:'Skoda Octavia', year:2023, color:'Синий', rating:5.0, orders_count:45, photo_url:'/driver-dmitry.jpg' },
  { id:'d8', name:'Галина Морозова', phone:'+79038901234', car:'Kia Rio X', year:2022, color:'Красный', rating:4.8, orders_count:78, photo_url:'/driver-galina.jpg' },
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

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  try {
    tg.ready(); tg.expand();
    applyTheme();

    if (tg.platform) {
      document.body.classList.add('telegram-webview');
    }

    bindAllEvents();
    tg.BackButton.onClick(function(){ goBack(); });
    tg.BackButton.hide();

    // Show menu screen first
    showScreen('menu');

    console.log('[MiniApp] v8 initialized');

    checkPaymentReturn();
  } catch (e) {
    console.error('[MiniApp] Init error:', e);
  }
});

// ── Apply theme ─────────────────────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════════════
//  NAVIGATION: position:absolute + z-index + visibility
//  NO transform, NO pointer-events, NO display:none on screens
// ═════════════════════════════════════════════════════════════════════════════

// Show screen by ID string (e.g. 'menu', 'routes', 'booking')
function showScreen(screenId) {
  // Remove .active from all screens
  document.querySelectorAll('.screen').forEach(function(s) {
    s.classList.remove('active');
  });

  // Add .active to target screen
  var target = document.getElementById('screen-' + screenId);
  if (target) {
    target.classList.add('active');
  } else {
    console.error('[MiniApp] Screen not found: screen-' + screenId);
  }

  // BackButton
  if (screenId === 'menu') {
    tg.BackButton.hide();
  } else {
    tg.BackButton.show();
  }

  // Haptic
  try { tg.HapticFeedback.impactOccurred('light'); } catch(e){}

  // Hide error
  var ef = document.getElementById('error-fallback');
  if (ef) ef.style.display = 'none';
}

// Go back based on current active screen
function goBack() {
  // Map: currentScreen -> previousScreen
  var map = {
    'routes': 'menu',
    'booking': 'routes',
    'drivers': 'booking',
    'success': 'menu',
    'orders': 'menu',
    'driver': 'menu',
    'become-driver': 'menu'
  };

  var current = document.querySelector('.screen.active');
  if (current) {
    var currentId = current.id.replace('screen-', '');
    var prev = map[currentId];
    if (prev) {
      showScreen(prev);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  EVENT BINDING — ALL via addEventListener, NO inline onclick
// ═════════════════════════════════════════════════════════════════════════════

function bindAllEvents() {
  // Menu buttons
  document.getElementById('menu-book').addEventListener('click', function() {
    loadRoutes();
    showScreen('routes');
  });
  document.getElementById('menu-orders').addEventListener('click', function() {
    loadOrders();
    showScreen('orders');
  });
  document.getElementById('menu-driver').addEventListener('click', function() {
    showScreen('driver');
    if (currentDriverId) { autoLoginDriver(); }
  });

  // Back buttons
  document.getElementById('btn-back-routes').addEventListener('click', function() { showScreen('menu'); });
  document.getElementById('btn-back-booking').addEventListener('click', function() { showScreen('routes'); });
  document.getElementById('btn-back-drivers').addEventListener('click', function() { showScreen('booking'); });
  document.getElementById('btn-back-orders').addEventListener('click', function() { showScreen('menu'); });
  document.getElementById('btn-back-driver').addEventListener('click', function() { showScreen('menu'); });
  document.getElementById('btn-back-become').addEventListener('click', function() { showScreen('menu'); });

  // Booking form → show drivers
  document.getElementById('booking-form').addEventListener('submit', function(e) {
    e.preventDefault();
    saveBookingFormAndShowDrivers();
  });

  // Success buttons
  document.getElementById('btn-success-orders').addEventListener('click', function() {
    loadOrders();
    showScreen('orders');
  });
  document.getElementById('btn-success-new').addEventListener('click', function() {
    showScreen('menu');
  });

  // Empty orders
  document.getElementById('btn-empty-book').addEventListener('click', function() {
    showScreen('routes');
  });

  // Driver login
  document.getElementById('btn-login-driver').addEventListener('click', loginDriver);

  // Driver tabs
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tabName = this.getAttribute('data-tab');
      if (tabName) showDriverTab(tabName, this);
    });
  });

  // Calendar nav
  document.getElementById('cal-prev').addEventListener('click', function() { changeMonth(-1); });
  document.getElementById('cal-next').addEventListener('click', function() { changeMonth(1); });

  // Driver registration form
  document.getElementById('driver-reg-form').addEventListener('submit', function(e) {
    e.preventDefault();
    submitDriverRegistration();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════════════════════════

var ALL_ROUTES = [
  { id:'r1', name:'Аэропорт → Горно-Алтайск', from_location:'Аэропорт Горно-Алтайск', to_location:'Горно-Алтайск', distance:5, duration:'15 мин', price:500 },
  { id:'r2', name:'Аэропорт → Манжерок', from_location:'Аэропорт Горно-Алтайск', to_location:'Манжерок', distance:25, duration:'30 мин', price:750 },
  { id:'r3', name:'Аэропорт → Чемал', from_location:'Аэропорт Горно-Алтайск', to_location:'Чемал', distance:80, duration:'1.5 часа', price:2400 },
  { id:'r4', name:'Аэропорт → Онгудай', from_location:'Аэропорт Горно-Алтайск', to_location:'Онгудай', distance:195, duration:'3 часа', price:5850 },
  { id:'r5', name:'Аэропорт → Усть-Кан', from_location:'Аэропорт Горно-Алтайск', to_location:'Усть-Кан', distance:180, duration:'3 часа', price:5400 },
  { id:'r6', name:'Аэропорт → Усть-Кокса', from_location:'Аэропорт Горно-Алтайск', to_location:'Усть-Кокса', distance:210, duration:'3.5 часа', price:6300 },
  { id:'r7', name:'Аэропорт → Акташ', from_location:'Аэропорт Горно-Алтайск', to_location:'Акташ', distance:330, duration:'5 часов', price:9900 },
  { id:'r8', name:'Аэропорт → Кош-Агач', from_location:'Аэропорт Горно-Алтайск', to_location:'Кош-Агач', distance:435, duration:'6 часов', price:13050 },
  { id:'r9', name:'Аэропорт → Улаган', from_location:'Аэропорт Горно-Алтайск', to_location:'Улаган', distance:380, duration:'5.5 часов', price:11400 },
  { id:'r10', name:'Аэропорт → Джазатор (Беляши)', from_location:'Аэропорт Горно-Алтайск', to_location:'Джазатор (Беляши)', distance:575, duration:'8 часов', price:17250 },
  { id:'r11', name:'Аэропорт → Телецкое озеро', from_location:'Аэропорт Горно-Алтайск', to_location:'Телецкое озеро', distance:300, duration:'5.5 часов', price:9000 },
  { id:'r12', name:'Горно-Алтайск → Чемал', from_location:'Горно-Алтайск', to_location:'Чемал', distance:75, duration:'1.5 часа', price:2250 },
  { id:'r13', name:'Манжерок → Чемал', from_location:'Манжерок', to_location:'Чемал', distance:55, duration:'1 час', price:1650 },
  { id:'r14', name:'Чемал → Телецкое озеро', from_location:'Чемал', to_location:'Телецкое озеро', distance:220, duration:'3.5 часа', price:6600 },
  { id:'r15', name:'Кош-Агач → Джазатор', from_location:'Кош-Агач', to_location:'Джазатор', distance:140, duration:'3 часа', price:4200 },
  { id:'r16', name:'Онгудай → Акташ', from_location:'Онгудай', to_location:'Акташ', distance:135, duration:'2.5 часа', price:4050 },
  { id:'r17', name:'Кош-Агач → Онгудай', from_location:'Кош-Агач', to_location:'Онгудай', distance:240, duration:'4 часа', price:7200 },
  { id:'r18', name:'Акташ → Улаган', from_location:'Акташ', to_location:'Улаган', distance:50, duration:'1 час', price:1500 },
];

function loadRoutes() {
  renderRoutes(ALL_ROUTES);
}

function renderRoutes(routes) {
  var c = document.getElementById('routes-list');
  if (!c) return;
  var html = '';
  routes.forEach(function(r) {
    var info = r.from_location + ' → ' + r.to_location + ' · ' + r.distance + ' км · ' + r.duration;
    html += '<div class="route-card" data-rid="'+r.id+'">'+
      '<div class="route-name">'+esc(r.name)+'</div>'+
      '<div class="route-info">'+esc(info)+'</div>'+
      '<div class="route-price">'+fp(r.price)+' ₽</div></div>';
  });
  c.innerHTML = html;
  c.querySelectorAll('.route-card').forEach(function(card) {
    card.addEventListener('click', function() {
      var rid = this.getAttribute('data-rid');
      var route = ALL_ROUTES.find(function(x) { return x.id === rid; });
      if (route) selectRoute(route);
    });
  });
}

function selectRoute(route) {
  selectedRoute = route;
  try { localStorage.setItem('selectedRoute', JSON.stringify(route)); } catch(e){}
  showBookingForm(route);
  showScreen('booking');
}

// ═════════════════════════════════════════════════════════════════════════════
//  BOOKING FORM
// ═════════════════════════════════════════════════════════════════════════════

function showBookingForm(route) {
  var s = document.getElementById('order-summary');
  if (s) {
    s.innerHTML = '<div style="font-weight:600;">'+esc(route.name)+'</div>'+
      '<div style="color:#999;font-size:13px;">'+esc(route.from_location)+' → '+esc(route.to_location)+'</div>'+
      '<div style="font-size:17px;font-weight:700;color:#2481cc;margin-top:6px;">'+fp(route.price)+' ₽</div>';
  }

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

  loadDrivers();
  showScreen('drivers');

  var el = document.getElementById('drivers-route-name');
  if (el && selectedRoute) el.textContent = selectedRoute.name;
}

// ═════════════════════════════════════════════════════════════════════════════
//  DRIVERS
// ═════════════════════════════════════════════════════════════════════════════

function loadDrivers() {
  // Use local driver list (no API call needed — we have all data)
  renderDrivers(ALL_DRIVERS);
}

function renderDrivers(drivers) {
  var c = document.getElementById('drivers-list');
  if (!c) return;
  var html = '';
  drivers.forEach(function(d) {
    var initial = d.name ? d.name.charAt(0) : '?';
    var carInfo = (d.car||'') + (d.year?' · '+d.year:'') + (d.color?' · '+d.color:'');
    var avatar = d.photo_url
      ? '<img src="'+d.photo_url+'" class="driver-avatar-img" alt="">'
      : '<div class="driver-avatar-placeholder">'+esc(initial)+'</div>';
    html += '<div class="driver-card" data-did="'+d.id+'">'+avatar+
      '<div class="driver-info">'+
      '<div class="driver-name">'+esc(d.name)+'</div>'+
      '<div class="driver-car">'+esc(carInfo)+'</div>'+
      '<div class="driver-rating">★ '+(d.rating||'5.0')+' · '+d.orders_count+' поездок</div></div></div>';
  });
  c.innerHTML = html;
  c.querySelectorAll('.driver-card').forEach(function(card) {
    card.addEventListener('click', function() {
      var did = this.getAttribute('data-did');
      var driver = drivers.find(function(x) { return x.id === did; });
      if (driver) selectDriver(driver);
    });
  });
}

function selectDriver(driver) {
  selectedDriver = driver;
  try { localStorage.setItem('selectedDriver', JSON.stringify(driver)); } catch(e){}

  if (!bookingFormData || !bookingFormData.date || !bookingFormData.time) {
    showError('Заполните дату и время поездки');
    showScreen('booking');
    return;
  }

  submitOrder();
}

// ═════════════════════════════════════════════════════════════════════════════
//  SUBMIT ORDER
// ═════════════════════════════════════════════════════════════════════════════

function submitOrder() {
  try {
    if (!selectedRoute) try { selectedRoute = JSON.parse(localStorage.getItem('selectedRoute')); } catch(e){}
    if (!selectedDriver) try { selectedDriver = JSON.parse(localStorage.getItem('selectedDriver')); } catch(e){}

    var date = bookingFormData ? bookingFormData.date : '';
    var time = bookingFormData ? bookingFormData.time : '';
    var passengers = bookingFormData ? bookingFormData.passengers : 1;
    var comment = bookingFormData ? bookingFormData.comment : '';

    console.log('[MiniApp] submitOrder:', {date:date, time:time, route:selectedRoute?selectedRoute.id:null, driver:selectedDriver?selectedDriver.id:null});

    if (!date) { showError('Выберите дату поездки'); return; }
    if (!time) { showError('Выберите время поездки'); return; }
    if (!selectedRoute || !selectedDriver) { showError('Выберите маршрут и водителя'); return; }

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

    console.log('[MiniApp] POST /api/orders body:', body);

    fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function(r) {
      console.log('[MiniApp] POST /api/orders response:', r.status);
      if (!r.ok) {
        if (r.status === 401) throw new Error('Ошибка авторизации. Закройте Mini App и откройте заново.');
        // Try to parse error as JSON, fallback to text
        return r.text().then(function(text) {
          console.error('[MiniApp] Server error response:', text.substring(0, 200));
          try { var d = JSON.parse(text); throw new Error(d.error || 'Ошибка сервера '+r.status); }
          catch(e) { throw new Error('Ошибка сервера '+r.status+'. Попробуйте позже.'); }
        });
      }
      return r.json();
    })
    .then(function(order) {
      console.log('[MiniApp] Order created:', order);

      var sd = document.getElementById('success-details');
      if (sd) sd.innerHTML = 'Заказ №'+(order.id||'-')+'<br>'+esc(selectedRoute.name)+'<br>'+fd(date)+' в '+time;

      showScreen('success');
      try { tg.HapticFeedback.notificationOccurred('success'); } catch(e){}

      // Try payment (non-blocking)
      try {
        var orderPrice = order.price || (selectedRoute ? selectedRoute.price : 0);
        initiatePaymentForOrder({ id: order.id, price: orderPrice, route_name: selectedRoute ? selectedRoute.name : '' });
      } catch(payErr) {
        console.error('[MiniApp] Payment init error (ignored):', payErr);
      }
    })
    .catch(function(e) {
      console.error('[MiniApp] Order error:', e);
      showError(e.message || 'Не удалось создать заказ');
    });
  } catch (e) {
    console.error('[MiniApp] submitOrder error:', e);
    showError('Ошибка: ' + e.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ORDERS
// ═════════════════════════════════════════════════════════════════════════════

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
    .then(function(r) { return r.json(); })
    .then(function(orders) { renderOrders(orders); })
    .catch(function(err) {
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
  orders.forEach(function(o) {
    var sc = 'status-' + (o.status || 'pending').toLowerCase();
    html += '<div class="order-card">'+
      '<div class="order-route">'+esc(o.route_name || 'Маршрут')+'</div>'+
      '<div class="order-meta">'+(o.date ? fd(o.date) : '')+' в '+(o.time || '--:--')+' · '+(o.driver_name || '')+'</div>'+
      '<span class="order-status '+sc+'">'+gst(o.status)+'</span>'+
      '<div class="order-price">'+fp(o.price)+' ₽</div></div>';
  });
  if (c) c.innerHTML = html;
}

// ═════════════════════════════════════════════════════════════════════════════
//  DRIVER DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════

function autoLoginDriver() {
  document.getElementById('driver-auth').style.display = 'none';
  document.getElementById('driver-content').style.display = 'block';
  loadDriverOrders('PENDING');
  loadCalendarFromServer();
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
  if (tabs) tabs.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('#screen-driver .tab-content').forEach(function(c) { c.classList.remove('active'); });
  var content = document.getElementById('tab-' + tab);
  if (content) content.classList.add('active');

  if (tab === 'incoming') loadDriverOrders('PENDING');
  else if (tab === 'active') loadDriverOrders('CONFIRMED');
  else if (tab === 'calendar') loadCalendarFromServer();
}

function loadDriverOrders(statusFilter) {
  if (!currentDriverId) return;
  var url = '/api/driver/orders?driver_id=' + encodeURIComponent(currentDriverId);
  if (statusFilter) url += '&status=' + statusFilter;

  var containerId = statusFilter === 'PENDING' ? 'incoming-list' : 'active-list';
  var emptyId = statusFilter === 'PENDING' ? 'incoming-empty' : 'active-empty';
  var showActions = statusFilter === 'PENDING';

  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(orders) { renderDriverOrders(orders, containerId, emptyId, showActions); })
    .catch(function(e) {
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
  orders.forEach(function(o) {
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
  c.querySelectorAll('.btn-confirm, .btn-cancel, .btn-complete').forEach(function(btn) {
    btn.addEventListener('click', function() {
      updateOrderStatus(this.getAttribute('data-oid'), this.getAttribute('data-st'));
    });
  });
}

function updateOrderStatus(oid, status) {
  fetch('/api/driver/orders/' + oid + '/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status })
  })
  .then(function(r) { return r.json(); })
  .then(function() {
    var activeTab = document.querySelector('#screen-driver .tab-btn.active');
    if (activeTab) {
      var tab = activeTab.getAttribute('data-tab');
      if (tab === 'incoming') loadDriverOrders('PENDING');
      else if (tab === 'active') loadDriverOrders('CONFIRMED');
    }
  })
  .catch(function(e) { showError('Ошибка обновления'); });
}

// ═════════════════════════════════════════════════════════════════════════════
//  CALENDAR
// ═════════════════════════════════════════════════════════════════════════════

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
      calendarState.busyDays = {};
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
  firstDay = firstDay === 0 ? 6 : firstDay - 1;

  var html = '';
  var dayLabels = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  dayLabels.forEach(function(d) { html += '<div class="cal-day-label">'+d+'</div>'; });

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

  grid.querySelectorAll('.cal-day:not(.past)').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var dateKey = this.getAttribute('data-date');
      calendarState.selectedDay = dateKey;
      toggleCalendarDay(dateKey);
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  DRIVER REGISTRATION
// ═════════════════════════════════════════════════════════════════════════════

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
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'Ошибка '+r.status); });
      return r.json();
    })
    .then(function(data) {
      if (btn) { btn.disabled = false; btn.textContent = 'Отправить заявку'; }
      var sd = document.getElementById('success-details');
      if (sd) sd.innerHTML = 'Заявка на регистрацию водителя отправлена!<br>Ваш ID: ' + esc(data.driver_id || '—') + '<br>Ожидайте SMS в течение 24 часов.';
      showScreen('success');
      try { tg.HapticFeedback.notificationOccurred('success'); } catch(e){}
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

// ═════════════════════════════════════════════════════════════════════════════
//  PAYMENTS
// ═════════════════════════════════════════════════════════════════════════════

function checkPaymentReturn() {
  try {
    var params = new URLSearchParams(window.location.search);
    var paymentId = params.get('payment');
    if (paymentId) {
      console.log('[Payment] Returning from payment, checking status...');
      var url = new URL(window.location.href);
      url.searchParams.delete('payment');
      window.history.replaceState({}, '', url.toString());
      currentPaymentId = paymentId;
      startPaymentPolling(paymentId);
    }
  } catch (e) {
    console.error('[Payment] checkPaymentReturn error:', e);
  }
}

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
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'Ошибка ' + r.status); });
      return r.json();
    })
    .then(function(data) {
      currentPaymentId = data.payment_id;
      currentOrderId = orderId;
      if (btn) { btn.disabled = false; btn.innerHTML = 'Выбрать водителя'; }
      showPaymentUI(data);
      resolve(data);
    })
    .catch(function(err) {
      if (btn) { btn.disabled = false; btn.innerHTML = 'Выбрать водителя'; }
      showError(err.message || 'Не удалось создать платёж');
      reject(err);
    });
  });
}

function showPaymentUI(paymentData) {
  var overlay = document.getElementById('payment-overlay');
  if (!overlay) {
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

  if (!document.getElementById('spin-style')) {
    var st = document.createElement('style');
    st.id = 'spin-style';
    st.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
  }

  document.getElementById('btn-pay-now').addEventListener('click', function() {
    if (paymentData.payment_url) {
      if (tg && tg.openLink) {
        tg.openLink(paymentData.payment_url, { try_instant_view: false });
      } else {
        window.open(paymentData.payment_url, '_blank');
      }
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

  paymentPollInterval = setInterval(function() {
    if (Date.now() - paymentStartTime > PAYMENT_TIMEOUT_MS) {
      stopPaymentPolling();
      showError('Время оплаты истекло. Попробуйте снова.');
      hidePaymentOverlay();
      return;
    }
    checkPaymentStatus(paymentId);
  }, 3000);

  checkPaymentStatus(paymentId);
}

function stopPaymentPolling() {
  if (paymentPollInterval) {
    clearInterval(paymentPollInterval);
    paymentPollInterval = null;
  }
}

function checkPaymentStatus(paymentId) {
  if (!paymentId) paymentId = currentPaymentId;
  if (!paymentId) return;

  fetch('/api/payments/' + encodeURIComponent(paymentId) + '/status')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.status === 'succeeded') {
        stopPaymentPolling();
        hidePaymentOverlay();
        showScreen('success');
        try { tg.HapticFeedback.notificationOccurred('success'); } catch(e){}
        try {
          tg.showPopup({ title: 'Оплачено!', message: 'Ваш заказ успешно оплачен. Водитель скоро свяжется с вами.' });
        } catch(e) {}
      } else if (data.status === 'canceled') {
        stopPaymentPolling();
        hidePaymentOverlay();
        showError('Платёж был отменён');
      }
    })
    .catch(function(err) {
      console.error('[Payment] Status check error:', err);
    });
}

function initiatePaymentForOrder(order) {
  var orderId = order.id;
  var amount = order.price || (selectedRoute ? selectedRoute.price : 0);
  var description = 'Заказ #' + orderId + ' — ' + (order.route_name || 'Алтай Трансфер');

  createPayment(orderId, amount, description)
    .then(function(paymentData) {
      console.log('[Payment] Payment created:', paymentData);
    })
    .catch(function(err) {
      console.log('[Payment] Payment skipped (not configured or error):', err.message);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
//  UTILS
// ═════════════════════════════════════════════════════════════════════════════

function esc(t) { if (!t) return ''; var d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; }
function fp(p) { if (!p && p !== 0) return '0'; return Number(p).toLocaleString('ru-RU'); }
function fd(s) { if (!s) return ''; var p = s.split('-'); if (p.length === 3) return p[2]+'.'+p[1]+'.'+p[0]; return s; }
function gst(s) { var m = {'PENDING':'Ожидает','CONFIRMED':'Подтверждён','COMPLETED':'Выполнен','CANCELLED':'Отменён'}; return m[s] || s || 'Ожидает'; }

function showError(msg) {
  console.error('[MiniApp]', msg);
  var ef = document.getElementById('error-fallback');
  var em = document.getElementById('error-message');
  if (ef && em) { em.textContent = msg; ef.style.display = 'block'; setTimeout(function() { ef.style.display = 'none'; }, 5000); }
  try { tg.showPopup({ title: 'Ошибка', message: msg }); } catch(e){}
}

window.onerror = function(m, s, l) { showError('Ошибка: ' + m + ' (строка ' + l + ')'); return false; };
window.addEventListener('unhandledrejection', function(ev) { showError('Ошибка: ' + (ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason))); });
