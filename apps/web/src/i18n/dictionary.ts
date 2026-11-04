// Every string the web app shows, in both languages. English is the base;
// Vietnamese must have the same keys (a test enforces it). Vietnamese drafts
// are to be checked with two techs and the front desk (Part 10).

export const LANGS = ['en', 'vi'] as const;
export type Lang = (typeof LANGS)[number];

const en = {
  app: {
    name: 'Turn board',
  },
  lang: {
    switchTo: 'Tiếng Việt',
    switchToAria: 'Switch to Vietnamese',
  },
  nav: {
    board: 'Board',
    staff: 'Staff',
    rules: 'Rules',
    log: 'Log',
    settings: 'Settings',
    signOut: 'Sign out',
  },
  landing: {
    title: "Who's next, on one screen.",
    lead: "A turn board for nail salons. Walk-ins go to the right technician by your salon's own rules, and everyone can see why.",
    signIn: 'Sign in',
    join: 'I have an invite code',
    demoCaption: 'How a Saturday afternoon looks on the board.',
  },
  login: {
    title: 'Sign in',
    contact: 'Email or phone number',
    sendCode: 'Send me a code',
    codeSentTo: 'We sent a code to {contact}.',
    code: '6-digit code',
    verify: 'Sign in',
    changeContact: 'Use a different email or phone',
    errors: {
      invalidContact: 'Enter an email address or a US phone number.',
      badCode: "That code didn't match. Check it and try again.",
      tooMany: 'Too many codes requested. Wait a few minutes and try again.',
      unknown: 'Something went wrong on our side. Try again.',
    },
  },
  join: {
    title: 'Join your salon',
    lead: 'Enter the invite code the owner gave you.',
    code: 'Invite code',
    name: 'Your name',
    continue: 'Continue',
    joiningAs: 'Joining {location} as {role}',
    errors: {
      unknown: "That invite code isn't valid. Ask the owner for a new one.",
      used: 'That invite code has been used. Ask the owner for a new one.',
      expired: 'That invite code has expired. Ask the owner for a new one.',
      name: 'Enter your name.',
      tooMany: 'Too many tries. Wait a few minutes and try again.',
    },
  },
  roles: {
    owner: 'owner',
    manager: 'manager',
    receptionist: 'receptionist',
    technician: 'technician',
  },
  board: {
    empty: 'Nobody is checked in yet.',
    points: 'points',
    waiting: 'waiting',
    backIn: 'back in',
    status: {
      available: 'available',
      called: 'called',
      in_service: 'in service',
      break: 'break',
      out: 'out',
    },
  },
  admin: {
    today: '{visits} visits today, {denies} denies, {overrides} overrides',
    welcome: 'Signed in as {name}',
    locationRole: '{location}, {role}',
    noSalon: "You're signed in but not part of a salon yet. Ask the owner for an invite code.",
  },
};

const vi: Dictionary = {
  app: {
    name: 'Bảng lượt',
  },
  lang: {
    switchTo: 'English',
    switchToAria: 'Chuyển sang tiếng Anh',
  },
  nav: {
    board: 'Bảng lượt',
    staff: 'Nhân viên',
    rules: 'Quy tắc',
    log: 'Nhật ký',
    settings: 'Cài đặt',
    signOut: 'Đăng xuất',
  },
  landing: {
    title: 'Ai tới lượt, trên một màn hình.',
    lead: 'Bảng lượt cho tiệm nail. Khách vãng lai được xếp đúng thợ theo quy tắc của tiệm, và ai cũng thấy lý do.',
    signIn: 'Đăng nhập',
    join: 'Tôi có mã mời',
    demoCaption: 'Bảng lượt vào một chiều thứ Bảy.',
  },
  login: {
    title: 'Đăng nhập',
    contact: 'Email hoặc số điện thoại',
    sendCode: 'Gửi mã cho tôi',
    codeSentTo: 'Đã gửi mã đến {contact}.',
    code: 'Mã 6 số',
    verify: 'Đăng nhập',
    changeContact: 'Dùng email hoặc số điện thoại khác',
    errors: {
      invalidContact: 'Nhập địa chỉ email hoặc số điện thoại Mỹ.',
      badCode: 'Mã không đúng. Kiểm tra lại và thử lần nữa.',
      tooMany: 'Yêu cầu mã quá nhiều lần. Chờ vài phút rồi thử lại.',
      unknown: 'Có lỗi từ phía chúng tôi. Thử lại.',
    },
  },
  join: {
    title: 'Tham gia tiệm của bạn',
    lead: 'Nhập mã mời chủ tiệm đã đưa cho bạn.',
    code: 'Mã mời',
    name: 'Tên của bạn',
    continue: 'Tiếp tục',
    joiningAs: 'Tham gia {location} với vai trò {role}',
    errors: {
      unknown: 'Mã mời không hợp lệ. Hỏi chủ tiệm để lấy mã mới.',
      used: 'Mã mời này đã được dùng. Hỏi chủ tiệm để lấy mã mới.',
      expired: 'Mã mời đã hết hạn. Hỏi chủ tiệm để lấy mã mới.',
      name: 'Nhập tên của bạn.',
      tooMany: 'Thử quá nhiều lần. Chờ vài phút rồi thử lại.',
    },
  },
  roles: {
    owner: 'chủ tiệm',
    manager: 'quản lý',
    receptionist: 'lễ tân',
    technician: 'thợ',
  },
  board: {
    empty: 'Chưa có ai điểm danh.',
    points: 'điểm',
    waiting: 'đang chờ',
    backIn: 'về sau',
    status: {
      available: 'sẵn sàng',
      called: 'được gọi',
      in_service: 'đang làm',
      break: 'nghỉ',
      out: 'ra ngoài',
    },
  },
  admin: {
    today: 'Hôm nay {visits} lượt khách, {denies} từ chối, {overrides} can thiệp',
    welcome: 'Đang đăng nhập: {name}',
    locationRole: '{location}, {role}',
    noSalon: 'Bạn đã đăng nhập nhưng chưa thuộc tiệm nào. Hỏi chủ tiệm để lấy mã mời.',
  },
};

export type Dictionary = typeof en;
export const dictionaries: Record<Lang, Dictionary> = { en, vi };

export function otherLang(lang: Lang): Lang {
  return lang === 'en' ? 'vi' : 'en';
}

/** Fill `{name}` slots. Missing values are left visible so they get noticed. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in values ? String(values[key]) : m,
  );
}
