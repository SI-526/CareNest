// Demo families for ?demo=1 (and the demo.html start page). Signed-in pages never show these:
// js/family-data.js replaces window.CareNestData with the real family before anything renders.
//
// The babysitter demo (Bethany) sits for two families and switches between them with the
// "Family space" bar:
//   thomas  Jack Thomas, age 3, and Kylie Thomas, age 6 (parent: Mary Ann Thomas)
//   rivera  Sofia Rivera, age 6 (parent: Ana Rivera)
// The parent demo is Mary Ann Thomas, so both sides tell the same story about Jack and Kylie.
// Kylie has no food info on purpose, so the demo shows "No information provided" (SI-49).
//
// Food, preferences, and instructions live on each child (`children`); js/children.js flatten()
// rebuilds the family-wide lists the older pages read.
//
// Today's session is built around the moment the tab first opened the demo (SESSION), and the
// sample photos are illustrations in assets/demo-photos/.
//
// Everything a tester changes (care info, contacts, sessions, check-offs, care logs, photos,
// the sitter and parent profiles) is kept in sessionStorage, so it lasts while the tab is open and is gone
// once the tab is closed. Nothing is sent to the database.
(function () {
  const DEMO_FLAG = "carenest:demo";
  const FAMILY_KEY = "carenest:demo:family";
  const dataKey = (familyId) => `carenest:demo:data:${familyId}`;
  const PARENT_PAGES = ["parent", "people", "manage", "account"];

  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;

  function inDemo() {
    try {
      return (
        new URLSearchParams(window.location.search).has("demo") ||
        sessionStorage.getItem(DEMO_FLAG) === "1"
      );
    } catch (e) {
      return false;
    }
  }

  // Local calendar date `offsetDays` from today as YYYY-MM-DD (the schedule page's date key).
  function dateKey(offsetDays) {
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  }

  function todayLabel() {
    return new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function phoneHref(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return digits.length >= 3 ? `tel:${digits}` : "";
  }

  function contact(id, name, role, phone, avatar) {
    return { id, name, firstName: name.split(/\s+/)[0], role, phone, phoneHref: phoneHref(phone), address: "", avatar: avatar || null };
  }

  function task(id, time, title, detail, extra) {
    return Object.assign({ id, time, title, detail: detail || null, location: null, map: null, careNote: null, completed: false }, extra || {});
  }

  const SEVERITY_CLASS = { Severe: "badge--severe", Moderate: "badge--moderate", Mild: "badge--mild" };
  function allergy(id, name, severity, description, image) {
    return { id, name, severity, severityClass: SEVERITY_CLASS[severity] || "", image: image || null, description };
  }

  // One home address for Bethany in both families (both are in Ann Arbor).
  const BETHANY_ADDRESS = "2214 Packard St, Ann Arbor, MI 48104";

  const KNOW_TILES = [
    { id: "food", label: "Food & allergies", icon: "assets/grocery.svg", href: "food-allergies.html" },
    { id: "preferences", label: "Preferences", icon: "assets/favorite.svg", href: "info.html?category=preferences" },
    { id: "where", label: "Where things are", icon: "assets/orders.svg", href: "info.html?category=where" },
    { id: "instructions", label: "Instructions", icon: "assets/assignment.svg", href: "info.html?category=instructions" },
  ];

  // ---------------------------------------------------------------- today's session

  // Today's session is built around the moment this tab first opened the demo, so a tester always
  // finds one under way: it started about an hour and a half earlier and runs about four hours.
  // The moment is kept for the tab, so every page (and both families) agree on the same times.
  const OPENED_KEY = "carenest:demo:opened";

  function openedAt() {
    const now = Date.now();
    let opened = NaN;
    try {
      opened = Number(sessionStorage.getItem(OPENED_KEY));
    } catch (e) {
      /* storage unavailable: anchor to now */
    }
    if (Number.isFinite(opened) && opened > 0 && opened <= now) return opened;
    try {
      if (inDemo()) sessionStorage.setItem(OPENED_KEY, String(now));
    } catch (e) {
      /* storage unavailable */
    }
    return now;
  }

  // Local YYYY-MM-DD of a timestamp.
  function isoDay(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // 1:30pm (task times) and 1:30 PM (session times).
  function clock(ms, upper) {
    const d = new Date(ms);
    const h = d.getHours();
    const text = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
    return upper ? text.replace(/(am|pm)$/, (m) => ` ${m.toUpperCase()}`) : text;
  }

  // The session window: starts on a quarter hour about 90 minutes before the demo opened (not
  // before midnight) and ends four hours later (not after 11:45pm, unless the demo opened later
  // than that). at(fraction) is a time inside it, on a 5 minute mark.
  function sessionWindow(opened) {
    const open = new Date(opened);
    const dayStart = new Date(open.getFullYear(), open.getMonth(), open.getDate()).getTime();
    const begin = new Date(opened - 90 * MINUTE);
    begin.setMinutes(Math.floor(begin.getMinutes() / 15) * 15, 0, 0);
    const start = Math.max(begin.getTime(), dayStart);
    let end = Math.min(start + 4 * HOUR, dayStart + 24 * HOUR - 15 * MINUTE);
    if (end < opened + 15 * MINUTE) end = Math.ceil((opened + 15 * MINUTE) / (15 * MINUTE)) * 15 * MINUTE;
    const fiveMinutes = 5 * MINUTE;
    return {
      opened,
      start,
      end,
      date: isoDay(start),
      hour: new Date(start).getHours(),
      at: (fraction) => Math.round((start + fraction * (end - start)) / fiveMinutes) * fiveMinutes,
    };
  }

  // The meal that fits the time of day.
  function mealAt(ms, menu) {
    const h = new Date(ms).getHours() + new Date(ms).getMinutes() / 60;
    if (h < 10.5) return { title: "Breakfast", detail: menu.breakfast };
    if (h < 15) return { title: "Lunch", detail: menu.lunch };
    return { title: "Dinner", detail: menu.dinner };
  }

  const SESSION = sessionWindow(openedAt());

  // ---------------------------------------------------------------- the Thomas family (Jack)

  function thomasFamily() {
    const t = {
      snack: SESSION.at(0.08),
      playground: SESSION.at(0.3),
      meal: SESSION.at(0.6),
      windDown: SESSION.at(0.88),
    };
    const meal = mealAt(t.meal, {
      breakfast: "Gluten-free oatmeal with berries",
      lunch: "Pasta and vegetables",
      dinner: "Pasta and vegetables",
    });
    const evening = new Date(t.windDown).getHours() >= 17;
    const schedule = [
      task("snack", clock(t.snack), "Snack", "Apples and cheese"),
      task("playground", clock(t.playground), "Playground", null, {
        location: "3175 Gallup Park Rd, Ann Arbor, MI 48104",
        map: "assets/map.png",
        careNote: "Spend ~1 hour playing. Make sure to pack snacks and drinks!",
      }),
      task("dinner", clock(t.meal), meal.title, meal.detail),
      evening
        ? task("wind-down", clock(t.windDown), "Wind down", "Bath time and reading")
        : task("wind-down", clock(t.windDown), "Quiet time", "Books and a rest on the couch"),
    ];
    const contacts = [
      contact("mary", "Mary Ann Thomas", "Parent", "588 - 909 - 3489", "assets/mary.png"),
      contact("david", "David Thomas", "Parent", "734 - 555 - 0142"),
      contact("linda", "Linda Thomas", "Grandmother", "616 - 555 - 0187"),
      contact("dr-shah", "Dr. Priya Shah", "Pediatrician", "734 - 555 - 0123"),
    ];
    return {
      familyName: "Thomas family",
      parentName: "Mary Ann Thomas",
      // The demo parent's sample sign-in address (Profile, Personal details, People).
      parentEmail: "mary.thomas@example.com",
      babysitter: { name: "Bethany", avatar: "assets/bethany.png", address: BETHANY_ADDRESS },
      child: { name: "Jack Thomas", age: "Age 3", avatar: null, dateLabel: todayLabel(), shiftTime: `${clock(SESSION.start)} - ${clock(SESSION.end)}` },
      homeAddress: "213 Maple Lane, Ann Arbor, MI 48104",
      primaryContactId: "mary",
      children: [
        {
          id: "jack",
          name: "Jack Thomas",
          age: "Age 3",
          stage: "Preschooler",
          pinnedNote: "",
          position: 0,
          careNote: "Epinephrine auto-injector (EpiPen) available in bathroom cabinet for use in the event of a severe allergic reaction.",
          food: [
            allergy("food-gluten", "Gluten-free", "Severe", "Avoid wheat, barley, and rye. Use separate utensils; check food labels.", "assets/gluten.png"),
            allergy("food-dairy", "Dairy-free", "Mild", "Avoid milk, cheese, and butter. Serve dairy-free alternatives.", "assets/dairy.png"),
            allergy("food-nuts", "Nut-free", "Severe", "Avoid nuts and nut traces. Follow the child’s allergy care plan.", "assets/nuts.png"),
          ],
          preferences: [
            { id: "pref-comfort", title: "Comfort item", detail: "Jack calms down with his blue stuffed elephant, Ellie. She usually lives on his bed." },
            { id: "pref-activities", title: "Favorite activities", detail: "Building with Duplo blocks, dinosaur books, and playing tag outside." },
            { id: "pref-foods", title: "Favorite foods", detail: "Apples, rice crackers, and pasta. Not a fan of broccoli, so offer peas instead." },
            { id: "pref-screens", title: "Screen time", detail: "Up to 30 minutes of PBS Kids on the living room TV. No tablets or phones." },
            { id: "pref-upset", title: "When he is upset", detail: "Offer a hug and count to five together. A quiet book on the couch usually helps." },
          ],
          instructions: [
            { id: "ins-labels", title: "Check every label", detail: "Only serve food that is gluten-, dairy-, and nut-free. When in doubt, don’t serve it." },
            { id: "ins-hands", title: "Handwashing", detail: "Wash hands before every meal and snack, and after the playground." },
            { id: "ins-outside", title: "Outside the house", detail: "Hold hands in parking lots and near the road. Put on sunscreen before the playground." },
            { id: "ins-bath", title: "Bath time", detail: "Keep the water lukewarm and never leave Jack alone in the tub, even for a moment." },
            { id: "ins-bed", title: "Bedtime", detail: "Pajamas, brush teeth, then two books. Lights out by 7:30pm with Ellie and the night light on." },
            { id: "ins-updates", title: "Updates for Mary", detail: "Send Mary a quick text after the playground and after dinner." },
          ],
        },
        {
          id: "kylie",
          name: "Kylie Thomas",
          age: "Age 6",
          stage: "1st Grader",
          pinnedNote: "Currently recovering from a cold",
          position: 1,
          careNote: "",
          food: [],
          preferences: [
            { id: "kylie-pref-reading", title: "Reading", detail: "Loves chapter books. She will read to you if you ask." },
          ],
          instructions: [
            { id: "kylie-ins-rest", title: "Rest", detail: "She is getting over a cold: quiet play inside, and plenty of water." },
          ],
        },
      ],
      dayNotes: [
        {
          id: "demo-pickup",
          category: "schedule",
          title: "Pick Jack up from soccer practice",
          detail: "Practice sometimes runs a little late. Bring his water bottle; it's by the front door.",
          createdAt: Date.now() - 3 * HOUR,
          updatedAt: Date.now() - 3 * HOUR,
        },
        {
          id: "demo-meds",
          category: "food_meds",
          title: "Amoxicillin with his next meal (5 ml)",
          detail: "The bottle is in the fridge door with the syringe next to it. Shake well first. He had his last dose before you arrived.",
          createdAt: Date.now() - 3 * HOUR,
          updatedAt: Date.now() - 25 * MINUTE,
        },
        {
          id: "demo-grandma",
          category: "other",
          title: "Grandma Linda may stop by to say hi",
          detail: "",
          createdAt: Date.now() - 2 * HOUR,
          updatedAt: Date.now() - 2 * HOUR,
        },
      ],
      contacts,
      schedule,
      appointments: [
        {
          id: "thomas-today",
          date: SESSION.date,
          start_time: clock(SESSION.start, true),
          end_time: clock(SESSION.end, true),
          note: "Jack has soccer practice today. Kylie is getting over a cold, so keep her inside.",
          activities: schedule.map((item) => Object.assign({}, item)),
          childIds: ["jack", "kylie"],
        },
        // SI-75: a session for one child only.
        { id: "thomas-date-night", date: dateKey(3), start_time: "6:00 PM", end_time: "10:00 PM", note: "Date night. Kylie is at a sleepover, so it's just Jack. His bedtime is 7:30pm.", activities: [], childIds: ["jack"] },
        { id: "thomas-saturday", date: dateKey(5), start_time: "11:00 AM", end_time: "5:00 PM", note: "", activities: [], childIds: ["jack", "kylie"] },
        // SI-80: an overnight session that ends after midnight.
        { id: "thomas-overnight", date: dateKey(8), start_time: "7:00 PM", end_time: "1:00 AM", note: "Wedding reception. Both kids in bed by 8:30pm; we'll be home around 1am.", activities: [], childIds: ["jack", "kylie"] },
      ],
      // SI-50: Bethany asked for a schedule for a day with no session yet (parent's Schedule page).
      scheduleRequests: [
        { id: "demo-request", date: dateKey(10), requestedBy: "bethany", requesterName: "Bethany", createdAt: Date.now() - 5 * HOUR },
      ],
      knowTiles: KNOW_TILES,
      categories: {
        preferences: { title: "Preferences", items: [] },
        where: {
          title: "Where things are",
          items: [
            { id: "where-epipen", title: "EpiPen", detail: "Bathroom cabinet, middle shelf. A second one is in the front pocket of the diaper bag." },
            { id: "where-firstaid", title: "First aid kit", detail: "Hall closet, top shelf, in the red zip bag." },
            { id: "where-snacks", title: "Snacks", detail: "Pantry, second shelf, in the bin labeled “Jack.” Everything in it is gluten-, dairy-, and nut-free." },
            { id: "where-pullups", title: "Pull-ups and wipes", detail: "Basket next to the dresser in Jack’s room." },
            { id: "where-clothes", title: "Spare clothes and pajamas", detail: "Bottom two drawers of Jack’s dresser." },
            { id: "where-stroller", title: "Stroller", detail: "Garage, just left of the door into the house." },
          ],
        },
        instructions: { title: "Instructions", items: [] },
        emergency: {
          title: "If something goes wrong",
          summary: "Emergency steps, hospital, and who to call",
          callout: { text: "If Jack or Kylie is in danger, not breathing, or having a severe allergic reaction, call 911 first.", label: "Call 911", href: "tel:911" },
          steps: [
            { id: "step-calm", title: "Stay calm.", detail: "Move Jack away from anything that could hurt him." },
            { id: "step-911", title: "Call 911 right away", detail: "if he is not breathing, will not wake up, is badly hurt, or is having a severe allergic reaction." },
            { id: "step-epipen", title: "Severe allergic reaction", detail: "(swelling, trouble breathing, hives): use the EpiPen from the bathroom cabinet on the outside of his thigh, then call 911." },
            { id: "step-poison", title: "Possible poisoning:", detail: "call Poison Control at 1-800-222-1222." },
            { id: "step-doctor", title: "Needs a doctor, not life-threatening:", detail: "drive him to the hospital below. Bring the diaper bag and his EpiPen." },
            { id: "step-call", title: "Call Mary", detail: "as soon as Jack is safe. If you cannot reach her, call the other contacts below in order." },
          ],
          hospital: {
            name: "C.S. Mott Children’s Hospital",
            system: "Michigan Medicine, Pediatric Emergency",
            address: "1540 E Hospital Dr, Ann Arbor, MI 48109",
            mapHref: "https://www.google.com/maps/search/?api=1&query=1540+E+Hospital+Dr%2C+Ann+Arbor%2C+MI+48109",
            phone: "734 - 555 - 0100",
            phoneHref: "tel:7345550100",
          },
          contacts,
        },
      },
      allergies: {
        title: "Food & allergies",
        sectionTitle: "Dietary restrictions",
        careNote: null,
        items: [],
      },
      // Today's shift as the tester finds it: the first two tasks done, with care logs, and Care
      // Log entries about each child (SI-63). Anything timed after the demo opened is left out.
      shiftSeed: {
        startedAt: SESSION.start + 5 * MINUTE,
        completions: [
          { taskId: "snack", at: t.snack + 10 * MINUTE, note: "Sliced apples and the dairy-free cheese from his bin." },
          { taskId: "playground", at: t.playground + 15 * MINUTE, note: "" },
        ],
        logs: [
          { taskId: "snack", at: t.snack + 12 * MINUTE, category: "meal", mealAmount: "most", note: "Ate all the apple slices, left about half the cheese." },
          { childId: "kylie", at: SESSION.start + 30 * MINUTE, note: "Took her temperature: normal. Drank a full glass of water and is reading on the couch. Still a little stuffy." },
          { taskId: "playground", at: t.playground + 17 * MINUTE, category: "care", note: "Sunscreen on before we left. Played tag and went down the big slide, no bumps or scrapes." },
          { taskId: "playground", at: t.playground + 20 * MINUTE, category: "care", note: "Drank his whole water bottle. A little tired on the walk back." },
          { childId: "jack", at: SESSION.start + 85 * MINUTE, note: "Built a tall Duplo tower and asked to save it for Mom to see." },
        ],
        // Sample photos (assets/demo-photos/), added once the images load (loadDemoPhotos below).
        photos: [
          // saved: in the parent's Album (parent.html#album). Only task photos and moments save.
          { kind: "task_proof", taskId: "playground", file: "playground.jpg", saved: true },
          { kind: "chat", file: "block-tower.jpg", at: SESSION.start + 86 * MINUTE, body: "Jack's tower. He wants you to see it before it comes down!" },
          { kind: "chat", file: "snack-plate.jpg", daysAgo: 2, minutes: 40, body: "Snack time: apples and rice crackers." },
          { kind: "moment", file: "story-time.jpg", daysAgo: 2, minutes: 200, body: "Story time with Ellie before bed.", saved: true },
          { kind: "moment", file: "drawing.jpg", daysAgo: 6, minutes: 95, body: "Kylie drew a picture of your house, sun and all.", saved: true },
        ],
      },
    };
  }

  // ---------------------------------------------------------------- the Rivera family (Sofia)

  function riveraFamily() {
    const t = {
      library: SESSION.at(0.02),
      snack: SESSION.at(0.15),
      reading: SESSION.at(0.3),
      piano: SESSION.at(0.48),
      meal: SESSION.at(0.62),
      bedtime: SESSION.at(0.88),
    };
    const meal = mealAt(t.meal, {
      breakfast: "Egg-free waffles and a clementine",
      lunch: "Rice, black beans, and cucumber",
      dinner: "Chicken quesadillas (egg-free tortillas) and cucumber",
    });
    const evening = new Date(t.bedtime).getHours() >= 17;
    const schedule = [
      // The ids are kept from earlier demo versions, so a tab that saved them still lines up.
      task("rivera-pickup", clock(t.library), "Library story time", "Children's room, second floor", {
        location: "Ann Arbor District Library, 343 S Fifth Ave, Ann Arbor, MI 48104",
        careNote: "Her library card is in the front pocket of her backpack. Return the books in the blue tote.",
      }),
      task("rivera-snack", clock(t.snack), "Snack", "Clementine and whole-grain crackers"),
      task("rivera-homework", clock(t.reading), "Reading time", "20 minutes of reading, then her worksheet"),
      task("rivera-piano", clock(t.piano), "Piano practice", "15 minutes on the songs marked in her book"),
      task("rivera-dinner", clock(t.meal), meal.title, meal.detail),
      evening
        ? task("rivera-bedtime", clock(t.bedtime), "Bath and bedtime", "Bath, pajamas, one chapter of her book")
        : task("rivera-bedtime", clock(t.bedtime), "Quiet time", "Drawing or LEGO at the kitchen table"),
    ];
    const contacts = [
      contact("ana", "Ana Rivera", "Parent", "734 - 555 - 0164"),
      contact("marco", "Marco Rivera", "Parent", "734 - 555 - 0178"),
      contact("rosa", "Rosa Delgado", "Aunt (lives nearby)", "734 - 555 - 0191"),
      contact("dr-okafor", "Dr. James Okafor", "Pediatrician", "734 - 555 - 0135"),
    ];
    return {
      familyName: "Rivera family",
      parentName: "Ana Rivera",
      babysitter: { name: "Bethany", avatar: "assets/bethany.png", address: BETHANY_ADDRESS },
      child: { name: "Sofia Rivera", age: "Age 6", avatar: null, dateLabel: todayLabel(), shiftTime: `${clock(SESSION.start)} - ${clock(SESSION.end)}` },
      homeAddress: "1802 Granger Ave, Ann Arbor, MI 48104",
      primaryContactId: "ana",
      children: [
        {
          id: "sofia",
          name: "Sofia Rivera",
          age: "Age 6",
          stage: "Kindergartner",
          pinnedNote: "",
          position: 0,
          careNote: "Children's Benadryl is in the kitchen cabinet above the microwave. Sofia's allergy is not severe enough for an EpiPen.",
          food: [
            allergy("rivera-food-egg", "Egg-free", "Moderate", "No eggs or foods made with egg, including most baked goods and fresh pasta."),
            allergy("rivera-food-sugar", "Limit sweets", "Mild", "One small treat after dinner at most."),
          ],
          preferences: [
            { id: "rivera-pref-comfort", title: "Comfort item", detail: "A purple blanket called Moo. It lives on her bed and comes to the couch for reading." },
            { id: "rivera-pref-activities", title: "Favorite activities", detail: "Drawing, LEGO Friends, and dancing to the Encanto soundtrack." },
            { id: "rivera-pref-foods", title: "Favorite foods", detail: "Clementines, quesadillas, and rice. She'll try new vegetables if she can dip them." },
            { id: "rivera-pref-screens", title: "Screen time", detail: "One show after homework is finished. No screens after dinner." },
            { id: "rivera-pref-upset", title: "When she is upset", detail: "Give her a few minutes with Moo, then ask her to draw what happened. She opens up while drawing." },
          ],
          instructions: [
            { id: "rivera-ins-eggs", title: "No eggs", detail: "Check labels for egg, including baked goods and pasta. Her egg-free snacks have a green sticker." },
            { id: "rivera-ins-homework", title: "Homework", detail: "Reading first, then the worksheet. Help only if she asks; she likes to try first." },
            { id: "rivera-ins-outside", title: "Outside", detail: "She can ride her scooter on the sidewalk with a helmet. Not past the corner." },
            { id: "rivera-ins-bed", title: "Bedtime", detail: "Lights out at 8:00pm. She sleeps with the hall light on." },
          ],
        },
      ],
      dayNotes: [
        {
          id: "rivera-library",
          category: "schedule",
          title: "Return her library books at story time",
          detail: "They're in the blue tote by the stairs. Her library card is in the front pocket of her backpack.",
          createdAt: Date.now() - 4 * HOUR,
          updatedAt: Date.now() - 4 * HOUR,
        },
        {
          id: "rivera-picture-day",
          category: "other",
          title: "Picture day tomorrow",
          detail: "Her outfit is hanging on the closet door. An early bedtime tonight, please.",
          createdAt: Date.now() - 2 * HOUR,
          updatedAt: Date.now() - 2 * HOUR,
        },
      ],
      contacts,
      schedule,
      appointments: [
        {
          id: "rivera-today",
          date: SESSION.date,
          start_time: clock(SESSION.start, true),
          end_time: clock(SESSION.end, true),
          note: "Piano lesson is tomorrow, so please don't skip practice.",
          activities: schedule.map((item) => Object.assign({}, item)),
          childIds: ["sofia"],
        },
        { id: "rivera-tomorrow", date: dateKey(1), start_time: "3:15 PM", end_time: "6:00 PM", note: "Ana is home by 6.", activities: [], childIds: ["sofia"] },
        { id: "rivera-next-week", date: dateKey(7), start_time: "3:15 PM", end_time: "8:00 PM", note: "", activities: [], childIds: ["sofia"] },
      ],
      knowTiles: KNOW_TILES,
      categories: {
        preferences: { title: "Preferences", items: [] },
        where: {
          title: "Where things are",
          items: [
            { id: "rivera-where-key", title: "House key", detail: "Lockbox on the side door. Code is 4-2-1-6." },
            { id: "rivera-where-firstaid", title: "First aid kit", detail: "Under the kitchen sink, in the white box." },
            { id: "rivera-where-snacks", title: "Snacks", detail: "Fruit bowl on the counter, crackers in the pantry on the bottom shelf." },
            { id: "rivera-where-homework", title: "Homework folder", detail: "Front pocket of her backpack, the red folder." },
            { id: "rivera-where-pajamas", title: "Pajamas", detail: "Top drawer of her dresser." },
          ],
        },
        instructions: { title: "Instructions", items: [] },
        emergency: {
          title: "If something goes wrong",
          summary: "Emergency steps, hospital, and who to call",
          callout: { text: "If Sofia is in danger, not breathing, or having a severe allergic reaction, call 911 first.", label: "Call 911", href: "tel:911" },
          steps: [
            { id: "rivera-step-calm", title: "Stay calm.", detail: "Move Sofia away from anything that could hurt her." },
            { id: "rivera-step-911", title: "Call 911 right away", detail: "if she is not breathing, will not wake up, is badly hurt, or is having a severe allergic reaction." },
            { id: "rivera-step-allergy", title: "Allergic reaction to egg", detail: "(hives, swelling, vomiting): give the children's Benadryl in the kitchen cabinet (1 tsp), then call Ana." },
            { id: "rivera-step-poison", title: "Possible poisoning:", detail: "call Poison Control at 1-800-222-1222." },
            { id: "rivera-step-call", title: "Call Ana", detail: "as soon as Sofia is safe. If you cannot reach her, call Marco, then Rosa." },
          ],
          hospital: {
            name: "C.S. Mott Children’s Hospital",
            system: "Michigan Medicine, Pediatric Emergency",
            address: "1540 E Hospital Dr, Ann Arbor, MI 48109",
            mapHref: "https://www.google.com/maps/search/?api=1&query=1540+E+Hospital+Dr%2C+Ann+Arbor%2C+MI+48109",
            phone: "734 - 555 - 0100",
            phoneHref: "tel:7345550100",
          },
          contacts,
        },
      },
      allergies: {
        title: "Food & allergies",
        sectionTitle: "Dietary restrictions",
        careNote: null,
        items: [],
      },
      shiftSeed: {
        startedAt: SESSION.start,
        completions: [
          { taskId: "rivera-pickup", at: t.library + 40 * MINUTE, note: "Returned the old books and checked out two new ones." },
          { taskId: "rivera-snack", at: t.snack + 25 * MINUTE, note: "" },
        ],
        logs: [
          { taskId: "rivera-pickup", at: t.library + 42 * MINUTE, category: "care", note: "Sat right up front for story time and answered all the questions. She picked two dinosaur books." },
          { taskId: "rivera-snack", at: t.snack + 27 * MINUTE, category: "meal", mealAmount: "some", note: "Ate the clementine, only a few crackers." },
          { childId: "sofia", at: SESSION.start + 80 * MINUTE, note: "Drew a picture of her house with the sun and birds. Very proud of it!" },
        ],
        photos: [
          { kind: "task_proof", taskId: "rivera-snack", file: "snack-plate.jpg" },
          { kind: "chat", file: "drawing.jpg", at: SESSION.start + 81 * MINUTE, body: "Sofia's drawing! She wants it on the fridge." },
          { kind: "moment", file: "story-time.jpg", daysAgo: 7, minutes: 150, body: "Story time before bed. She read two pages to me!", saved: true },
        ],
      },
    };
  }

  const FAMILIES = { thomas: thomasFamily, rivera: riveraFamily };
  const FAMILY_IDS = Object.keys(FAMILIES);

  // The parent demo is always the Thomas family; the babysitter demo shows the family this tab
  // picked last (the Thomas family first).
  function isParentView() {
    const page = document.body && document.body.dataset.page;
    return PARENT_PAGES.includes(page) || new URLSearchParams(window.location.search).get("as") === "parent";
  }

  function chosenFamily() {
    try {
      const saved = sessionStorage.getItem(FAMILY_KEY);
      if (FAMILY_IDS.includes(saved)) return saved;
    } catch (e) {
      /* storage unavailable */
    }
    return "thomas";
  }

  const familyId = isParentView() ? "thomas" : chosenFamily();

  // What the pages read but the family does not store twice: each child's items as family-wide
  // lists (js/children.js), and the primary contact.
  function derive(data) {
    if (window.CareNestChildren) window.CareNestChildren.flatten(data);
    data.primaryContact = data.contacts.find((c) => c.id === data.primaryContactId) || null;
    data.categories.emergency.contacts = data.contacts; // one list, as when signed in
    nameChildren(data);
    return data;
  }

  function load(id) {
    if (inDemo()) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(dataKey(id)) || "null");
        // A tab saved before children existed has no `children`: start that family afresh.
        if (saved && typeof saved === "object" && Array.isArray(saved.children)) {
          saved.child.dateLabel = todayLabel();
          return derive(saved);
        }
      } catch (e) {
        /* unreadable: start from the sample */
      }
    }
    return derive(FAMILIES[id]());
  }

  window.CareNestData = load(familyId);

  // ---------------------------------------------------------------- demo helpers

  function save() {
    try {
      sessionStorage.setItem(dataKey(familyId), JSON.stringify(window.CareNestData));
      return null;
    } catch (e) {
      return new Error("This browser tab is out of storage space, so this wasn't saved.");
    }
  }

  function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // "15:00:00" -> "3:00pm" (the editors send database-style times).
  function displayTime(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(value || "");
    if (!match) return value || "";
    const hours = Number(match[1]);
    return `${hours % 12 === 0 ? 12 : hours % 12}:${match[2]}${hours >= 12 ? "pm" : "am"}`;
  }

  const PER_CHILD = ["food", "preferences", "instructions"];

  function childById(id) {
    return window.CareNestData.children.find((child) => child.id === id) || null;
  }

  // The Call 911 callout names the children, as js/family-data.js does when signed in.
  function nameChildren(data) {
    if (window.CareNestChildren) data.categories.emergency.callout.text = window.CareNestChildren.emergencyText(data.children);
  }

  // The rows the parent editors (js/children-page.js, js/secondary.js) write, applied to this tab's demo
  // family. `scope` is { id } or { household_id } from .eq(). Returns { error, id }.
  function applyWrite(table, action, values, scope) {
    const data = window.CareNestData;
    values = values || {};
    const id = scope.id;
    let createdId = null;
    if (table === "households" && action === "update") {
      // An old-style save of the first child's name or age, as the database's sync trigger does.
      const first = data.children[0];
      if (first && "child_name" in values) first.name = values.child_name || "";
      if (first && "child_age_label" in values) first.age = values.child_age_label || "";
      if ("home_address" in values) data.homeAddress = values.home_address || "";
    } else if (table === "children") {
      const fields = {};
      if ("name" in values) fields.name = values.name || "";
      if ("age_label" in values) fields.age = values.age_label || "";
      if ("stage_label" in values) fields.stage = values.stage_label || "";
      if ("pinned_note" in values) fields.pinnedNote = values.pinned_note || "";
      if ("position" in values) fields.position = Number(values.position) || 0;
      if (action === "insert") {
        createdId = newId("child");
        data.children.push(Object.assign({ id: createdId, name: "", age: "", stage: "", pinnedNote: "", position: 0, careNote: "", food: [], preferences: [], instructions: [] }, fields));
      } else if (action === "delete") {
        // As the database cascades: the child's own items go with it.
        data.children = data.children.filter((child) => child.id !== id);
      } else {
        const child = childById(id);
        if (!child) return { error: new Error("That child is no longer here. Reload the page.") };
        Object.assign(child, fields);
      }
    } else if (table === "plans" && action === "update") {
      if ("schedule" in values) data.child.shiftTime = values.schedule || "";
    } else if (table === "tasks") {
      const fields = {
        title: values.title,
        time: displayTime(values.time_of_day),
        detail: values.detail || null,
        location: values.location || null,
      };
      if (action === "insert") data.schedule.push(task(newId("task"), fields.time, fields.title, fields.detail, { location: fields.location }));
      else if (values.archived_at) data.schedule = data.schedule.filter((t) => t.id !== id);
      else Object.assign(data.schedule.find((t) => t.id === id) || {}, fields);
    } else if (table === "contacts") {
      if ("is_primary" in values) {
        // One primary contact per family, as the database's unique index allows.
        if (values.is_primary) data.primaryContactId = id;
        else if (!id || data.primaryContactId === id) data.primaryContactId = null;
      }
      const fields = ["name", "role", "phone", "address"].filter((key) => key in values);
      if (action === "delete") {
        data.contacts = data.contacts.filter((c) => c.id !== id);
        if (data.primaryContactId === id) data.primaryContactId = null;
      } else if (action === "insert") {
        createdId = newId("contact");
        const row = contact(createdId, values.name || "Contact", values.role || "", values.phone || "");
        row.address = values.address || "";
        data.contacts.push(row);
        if (values.is_primary) data.primaryContactId = createdId;
      } else if (fields.length) {
        const existing = data.contacts.find((c) => c.id === id);
        if (existing) {
          const merged = Object.assign({ name: existing.name, role: existing.role, phone: existing.phone, address: existing.address }, values);
          Object.assign(existing, contact(id, merged.name || "Contact", merged.role || "", merged.phone || "", existing.avatar), { address: merged.address || "" });
        }
      }
    } else if (table === "care_items") {
      const found = action === "insert" ? null : findItem(id);
      const category = action === "insert" ? values.category : found && found.category;
      if (!category) return { error: new Error("That item is no longer here. Reload the page.") };
      let list;
      if (PER_CHILD.includes(category)) {
        // A save with no child goes to the first child, as the database's default-child trigger does.
        const owner = found ? found.child : childById(values.child_id) || data.children[0];
        if (!owner) return { error: new Error("Add a child first.") };
        list = owner[category];
      } else {
        list = category === "emergency" ? data.categories.emergency.steps : data.categories[category].items;
      }
      const index = list.findIndex((item) => item.id === id);
      if (action === "delete") {
        if (index >= 0) list.splice(index, 1);
      } else {
        const itemId = index >= 0 ? id : (createdId = newId(category));
        const item =
          category === "food"
            ? allergy(itemId, values.title, values.severity || "", values.detail || "", index >= 0 ? list[index].image : null)
            : { id: itemId, title: values.title, detail: values.detail || "" };
        if (index >= 0) list.splice(index, 1, item);
        else list.push(item);
      }
    } else {
      return { error: new Error("This can't be changed in the demo.") };
    }
    derive(data);
    return { error: save(), id: createdId || id };
  }

  // Which list holds a care item: a child's own, or a family-wide category.
  function findItem(id) {
    const data = window.CareNestData;
    for (const child of data.children) {
      const category = PER_CHILD.find((key) => child[key].some((item) => item.id === id));
      if (category) return { category, child };
    }
    if (data.categories.emergency.steps.some((step) => step.id === id)) return { category: "emergency" };
    if (data.categories.where.items.some((item) => item.id === id)) return { category: "where" };
    return null;
  }

  // Just enough of the Supabase client's query builder for the parent editors:
  // from(table).insert(values) / .update(values).eq(column, value) / .delete().eq("id", id).
  const client = {
    from(table) {
      let action = null;
      let values = null;
      const scope = {};
      const builder = {
        insert(v) { action = "insert"; values = v; return builder; },
        update(v) { action = "update"; values = v; return builder; },
        delete() { action = "delete"; return builder; },
        eq(column, value) { scope[column] = value; return builder; },
        select() { return builder; },
        single() { return builder; },
        then(resolve, reject) {
          let result;
          try {
            result = applyWrite(table, action, values, scope);
          } catch (e) {
            result = { error: e };
          }
          const row = { id: result.id };
          return Promise.resolve({ data: result.error ? null : Object.assign([row], row), error: result.error || null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  // The care log and check-offs this tab starts with (js/store.js reads it once). Times come from
  // the family's session (SESSION); anything timed after now is left out, so the log never shows
  // an entry from the future (the session is clamped to start at midnight on a late-night visit).
  function shiftSeed() {
    const data = window.CareNestData;
    const seed = data.shiftSeed;
    if (!seed) return null;
    const now = Date.now();
    const shiftId = newId("shift");
    const startedAt = Math.min(seed.startedAt, now);
    const completions = {};
    seed.completions
      .filter((c) => c.at <= now)
      .forEach((c) => {
        completions[c.taskId] = { taskId: c.taskId, photoDataUrl: null, note: c.note || "", tag: "", sentAt: c.at, sender: "sitter" };
      });
    const childName = (id) => {
      const child = (data.children || []).find((c) => c.id === id);
      return child ? child.name : "";
    };
    const logs = seed.logs
      // A task log needs its task checked off, as the database requires.
      .filter((l) => l.at <= now && (l.childId || completions[l.taskId]))
      .map((l) =>
        l.childId
          ? { id: newId("log"), shiftId, taskId: null, childId: l.childId, childName: childName(l.childId), category: "note", note: l.note, mealAmount: null, bottleOz: null, author: "sitter", createdAt: l.at }
          : {
              id: newId("log"),
              shiftId,
              taskId: l.taskId,
              category: l.category,
              note: l.note || "",
              mealAmount: l.mealAmount || null,
              bottleOz: l.bottleOz == null ? null : l.bottleOz,
              author: l.author === "parent" ? "parent" : "sitter",
              createdAt: l.at,
            }
      );
    return {
      completions,
      // The sample photos are added by loadDemoPhotos() once their images have loaded.
      messages: [],
      // The photo prompt ("moment") is due a few minutes after the tester opens the page.
      shift: { id: shiftId, startedAt, endedAt: null, momentAt: now + (2 + Math.floor(Math.random() * 3)) * MINUTE, events: [] },
      reads: {},
      saves: {},
      insights: {},
      logs,
    };
  }

  // Sample photos for the Album, the sitter's Gallery, and the parent's Photos card: illustrations
  // in assets/demo-photos/ (no real children). The demo stores photos as data URLs, so each image
  // is fetched and converted once per tab, then handed to js/store.js. Pages that show photos
  // re-render when the store changes. Only on pages that load the store.
  function photoDataUrl(file) {
    return fetch(`assets/demo-photos/${file}`)
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(response.statusText))))
      .then(
        (blob) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          })
      );
  }

  async function loadDemoPhotos() {
    const store = window.CareNestStore;
    const seed = window.CareNestData && window.CareNestData.shiftSeed;
    if (!store || !store.seedDemoPhotos || !seed || !seed.photos || !store.needsDemoPhotos()) return;
    const now = Date.now();
    const wanted = seed.photos.filter((photo) => photo.at == null || photo.at <= now);
    const files = Array.from(new Set(wanted.map((photo) => photo.file)));
    const urls = {};
    await Promise.all(
      files.map((file) =>
        photoDataUrl(file)
          .then((url) => {
            urls[file] = url;
          })
          .catch(() => {
            /* a photo that fails to load is left out */
          })
      )
    );
    const day = 24 * HOUR;
    store.seedDemoPhotos(
      wanted
        .filter((photo) => urls[photo.file])
        .map((photo) => ({
          kind: photo.kind,
          taskId: photo.taskId || null,
          body: photo.body || "",
          photoDataUrl: urls[photo.file],
          // Photos from an earlier session (one per day) were seen then; they are not this shift's.
          pastShift: photo.daysAgo ? `demo-past-${photo.daysAgo}` : null,
          seen: Boolean(photo.daysAgo),
          saved: Boolean(photo.saved),
          sentAt: photo.daysAgo ? SESSION.start - photo.daysAgo * day + (photo.minutes || 90) * MINUTE : photo.at || null,
        }))
    );
  }

  // After js/auth.js has picked this tab's demo store (its storeKey), so the photos land in the
  // family on screen.
  if (inDemo() && window.CareNestAuth && window.CareNestAuth.ready) {
    window.CareNestAuth.ready.then(() => loadDemoPhotos()).catch(() => {});
  }

  const SITTER_PROFILE_KEY = "carenest:demo:sitter-profile";
  const PARENT_PROFILE_KEY = "carenest:demo:parent-profile";
  const SITTER_PROFILE = {
    name: "Bethany",
    bio: "Education student at the University of Michigan. CPR and first aid certified, with four years of babysitting experience with toddlers and school-age kids.",
    phone: "734 - 555 - 0110",
    availability: "Weekday afternoons and most weekends",
    showBio: true,
    showPhone: false,
    showAvailability: true,
    updates: true,
  };

  window.CareNestDemo = {
    familyId,
    familyName: window.CareNestData.familyName,
    // The babysitter's family spaces, in the shape js/auth.js's family switcher reads.
    memberships: FAMILY_IDS.map((id) => ({ household_id: id, role: "caretaker", households: { name: FAMILIES[id]().familyName } })),
    switchTo(id) {
      if (!FAMILY_IDS.includes(id)) return;
      try {
        sessionStorage.setItem(FAMILY_KEY, id);
      } catch (e) {
        /* storage unavailable: stays on this family */
      }
    },
    storeKey: `carenest:demo:v1:${familyId}`,
    shiftSeed,
    save,
    client,
    loadSitterProfile() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(SITTER_PROFILE_KEY) || "null");
        if (saved && typeof saved === "object") return Object.assign({}, SITTER_PROFILE, saved);
      } catch (e) {
        /* unreadable: the sample profile */
      }
      return Object.assign({}, SITTER_PROFILE);
    },
    // The demo parent's personal details (account.html): the sample parent's name and their
    // number from the sample contacts, with this tab's edits.
    loadParentProfile() {
      const sample = window.CareNestData || {};
      const own = (sample.contacts || []).find((c) => c.name === sample.parentName);
      const base = { name: sample.parentName || "", phone: own ? own.phone : "", sharePhone: true };
      try {
        const saved = JSON.parse(sessionStorage.getItem(`${PARENT_PROFILE_KEY}:${familyId}`) || "null");
        if (saved && typeof saved === "object") return Object.assign(base, saved);
      } catch (e) {
        /* unreadable: the sample details */
      }
      return base;
    },
    saveParentProfile(profile) {
      try {
        sessionStorage.setItem(`${PARENT_PROFILE_KEY}:${familyId}`, JSON.stringify(profile));
        return null;
      } catch (e) {
        return new Error("This browser tab is out of storage space, so this wasn't saved.");
      }
    },
    saveSitterProfile(profile) {
      try {
        sessionStorage.setItem(SITTER_PROFILE_KEY, JSON.stringify(profile));
        return null;
      } catch (e) {
        return new Error("This browser tab is out of storage space, so this wasn't saved.");
      }
    },
  };
})();
