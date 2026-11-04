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
    signedInAs:
      "You're signed in as {name}. An invite code is for a new account, so sign out first, then enter the code.",
    errors: {
      unknown: "That invite code isn't valid. Ask the owner for a new one.",
      used: 'That invite code has been used. Ask the owner for a new one.',
      expired: 'That invite code has expired. Ask the owner for a new one.',
      name: 'Enter your name.',
      tooMany: 'Too many tries. Wait a few minutes and try again.',
    },
  },
  setup: {
    link: 'Set up a new salon',
    title: 'Set up your salon',
    lead: 'Enter the setup code you were given, then your salon details.',
    code: 'Setup code',
    name: 'Your name',
    salonName: 'Salon name',
    locationName: 'Location name (for example, Main or Brandon)',
    continue: 'Continue',
    errors: {
      unknown: "That setup code isn't valid.",
      used: 'That setup code has been used.',
      expired: 'That setup code has expired.',
      fields: 'Fill in your name, the salon name and the location name.',
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
      off: 'off',
      checked_in: 'checked in',
      available: 'available',
      called: 'called',
      in_service: 'in service',
      break: 'break',
      out: 'out',
    },
  },
  me: {
    statusLine: 'You are {status}',
    pointsToday: 'points today',
    notTechnician: "You're signed in, but you're not a technician at any salon.",
    inServiceNote:
      'Tap Finished when the service is done; your points post and you are back in line.',
    call: {
      title: "You're called",
      waitedLine: 'waiting for your answer, {seconds} s',
      accept: 'Accept',
      deny: 'Deny',
      penaltyNote: 'Denying adds {points} point to your total today. Pick the reason:',
      back: 'Back',
      reasons: {
        not_my_service: 'Not my service',
        with_another_client: 'With another client',
        break_needed: 'Need a break',
        client_issue: 'Issue with this client',
        other: 'Other',
      },
    },
    actions: {
      check_in: "I'm here",
      available: "I'm ready",
      break: 'Break',
      out: 'Out',
      off: 'Check out',
      finish: 'Finished',
    },
    errors: {
      illegal_transition: "That move isn't possible from where you are. Refresh and try again.",
      outside_geofence:
        "You're {distance} m from the salon; check-in works within {radius} m. Try again inside.",
      no_location_fix:
        'Your phone did not share a location. Allow location for this site and try again.',
      poor_location_accuracy:
        'Your phone is only sure of its position to about {accuracy} m; the salon fence is {radius} m. Step outside or wait a moment and try again.',
      not_technician: "You're not a technician at any salon.",
      not_your_call: "That call isn't yours any more. Refresh.",
      already_answered: 'That call was already answered.',
      no_visit_in_service: "There's no service in progress to finish.",
    },
  },
  desk: {
    walkIn: 'New walk-in',
    pickServices: 'Pick the services. The engine calls the next technician.',
    addWalkIn: 'Add to the queue',
    requestedTech: 'Asked for a specific technician?',
    anyTech: 'Anyone (next in line)',
    note: 'Special request (optional)',
    notePlaceholder: 'for example: wants a woman, kid, in a hurry',
    forTech: 'for {name}',
    waiting: 'Waiting',
    nobodyWaiting: 'Nobody waiting.',
    callNext: 'Call next',
    waitingLine: 'waiting {time}',
    calledLine: '{name} called, no answer for {time}',
    inService: 'in service',
    errors: {
      no_services: 'Pick at least one service.',
      unknown_service: 'One of those services is not on the menu any more. Refresh.',
      nobody_eligible: 'Nobody can be called right now.',
      visit_not_waiting: 'That visit is already being handled.',
      not_allowed: 'Your role cannot do that.',
    } as Record<string, string>,
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
    signedInAs:
      'Bạn đang đăng nhập là {name}. Mã mời dành cho tài khoản mới, nên hãy đăng xuất trước rồi nhập mã.',
    errors: {
      unknown: 'Mã mời không hợp lệ. Hỏi chủ tiệm để lấy mã mới.',
      used: 'Mã mời này đã được dùng. Hỏi chủ tiệm để lấy mã mới.',
      expired: 'Mã mời đã hết hạn. Hỏi chủ tiệm để lấy mã mới.',
      name: 'Nhập tên của bạn.',
      tooMany: 'Thử quá nhiều lần. Chờ vài phút rồi thử lại.',
    },
  },
  setup: {
    link: 'Lập tiệm mới',
    title: 'Lập tiệm của bạn',
    lead: 'Nhập mã lập tiệm bạn được cấp, rồi thông tin tiệm.',
    code: 'Mã lập tiệm',
    name: 'Tên của bạn',
    salonName: 'Tên tiệm',
    locationName: 'Tên chi nhánh (ví dụ: Chính hoặc Brandon)',
    continue: 'Tiếp tục',
    errors: {
      unknown: 'Mã lập tiệm không hợp lệ.',
      used: 'Mã lập tiệm này đã được dùng.',
      expired: 'Mã lập tiệm đã hết hạn.',
      fields: 'Điền tên của bạn, tên tiệm và tên chi nhánh.',
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
      off: 'chưa vào ca',
      checked_in: 'đã điểm danh',
      available: 'sẵn sàng',
      called: 'được gọi',
      in_service: 'đang làm',
      break: 'nghỉ',
      out: 'ra ngoài',
    },
  },
  me: {
    statusLine: 'Bạn đang {status}',
    pointsToday: 'điểm hôm nay',
    notTechnician: 'Bạn đã đăng nhập nhưng không phải là thợ ở tiệm nào.',
    inServiceNote: 'Bấm Xong khi làm xong; điểm được ghi và bạn trở lại hàng chờ.',
    call: {
      title: 'Bạn được gọi',
      waitedLine: 'đang chờ bạn trả lời, {seconds} giây',
      accept: 'Nhận',
      deny: 'Từ chối',
      penaltyNote: 'Từ chối cộng {points} điểm vào tổng hôm nay của bạn. Chọn lý do:',
      back: 'Quay lại',
      reasons: {
        not_my_service: 'Không phải dịch vụ của tôi',
        with_another_client: 'Đang làm khách khác',
        break_needed: 'Cần nghỉ',
        client_issue: 'Có vấn đề với khách này',
        other: 'Lý do khác',
      },
    },
    actions: {
      check_in: 'Tôi đã đến',
      available: 'Tôi sẵn sàng',
      break: 'Nghỉ',
      out: 'Ra ngoài',
      off: 'Kết thúc ca',
      finish: 'Xong',
    },
    errors: {
      illegal_transition: 'Không thể chuyển từ trạng thái hiện tại. Tải lại trang rồi thử lại.',
      outside_geofence:
        'Bạn cách tiệm {distance} m; điểm danh chỉ được trong vòng {radius} m. Vào trong rồi thử lại.',
      no_location_fix: 'Điện thoại chưa chia sẻ vị trí. Cho phép vị trí cho trang này rồi thử lại.',
      poor_location_accuracy:
        'Điện thoại chỉ xác định được vị trí trong khoảng {accuracy} m; vùng tiệm là {radius} m. Ra chỗ thoáng hoặc chờ một chút rồi thử lại.',
      not_technician: 'Bạn không phải là thợ ở tiệm nào.',
      not_your_call: 'Lượt gọi này không còn của bạn. Tải lại trang.',
      already_answered: 'Lượt gọi này đã được trả lời.',
      no_visit_in_service: 'Không có lượt nào đang làm để kết thúc.',
    },
  },
  desk: {
    walkIn: 'Khách mới',
    pickServices: 'Chọn dịch vụ. Hệ thống sẽ gọi thợ kế tiếp.',
    addWalkIn: 'Thêm vào hàng chờ',
    requestedTech: 'Khách yêu cầu thợ nào không?',
    anyTech: 'Ai cũng được (theo thứ tự)',
    note: 'Yêu cầu đặc biệt (không bắt buộc)',
    notePlaceholder: 'ví dụ: muốn thợ nữ, trẻ em, đang vội',
    forTech: 'cho {name}',
    waiting: 'Đang chờ',
    nobodyWaiting: 'Không có ai chờ.',
    callNext: 'Gọi thợ kế tiếp',
    waitingLine: 'chờ {time}',
    calledLine: 'Đã gọi {name}, chưa trả lời {time}',
    inService: 'đang làm',
    errors: {
      no_services: 'Chọn ít nhất một dịch vụ.',
      unknown_service: 'Một dịch vụ không còn trong thực đơn. Tải lại trang.',
      nobody_eligible: 'Hiện không gọi được ai.',
      visit_not_waiting: 'Lượt khách này đang được xử lý.',
      not_allowed: 'Vai trò của bạn không làm được việc này.',
    } as Record<string, string>,
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
