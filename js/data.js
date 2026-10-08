window.CareNestData = {
  babysitter: {
    name: "Bethany",
    avatar: "assets/bethany.png",
    address: "51900 Beck St., Grand Rapids, MI, 48091",
  },

  child: {
    name: "Jack Thomas",
    age: "Age 3",
    avatar: "assets/avatar.png",
    dateLabel: "Mon, Oct 5",
    shiftTime: "3:00pm - 7:00pm",
  },

  contacts: [
    {
      id: "mary",
      name: "Mary Ann Thomas",
      firstName: "Mary",
      phone: "588 - 909 - 3489",
      phoneHref: "tel:5889093489",
      avatar: "assets/mary.png",
    },
  ],

  schedule: [
    {
      id: "snack",
      time: "1:30pm",
      title: "Snack",
      detail: "Apples and cheese",
      location: null,
      map: null,
      careNote: null,
      completed: false,
    },
    {
      id: "playground",
      time: "3:00pm",
      title: "Playground",
      detail: null,
      location: "3175 Gallup Park Rd, Ann Arbor, MI 48104",
      map: "assets/map.png",
      careNote: "Spend ~1 hour playing. Make sure to pack snacks and drinks!",
      completed: false,
    },
    {
      id: "dinner",
      time: "5:00pm",
      title: "Dinner",
      detail: "Pasta and vegetables",
      location: null,
      map: null,
      careNote: null,
      completed: false,
    },
    {
      id: "wind-down",
      time: "7:00pm",
      title: "Wind down",
      detail: "Bath time and reading",
      location: null,
      map: null,
      careNote: null,
      completed: false,
    },
  ],

  knowTiles: [
    {
      id: "food",
      label: "Food & allergies",
      icon: "assets/grocery.svg",
      href: "food-allergies.html",
    },
    {
      id: "preferences",
      label: "Preferences",
      icon: "assets/favorite.svg",
      href: "info.html?category=preferences",
    },
    {
      id: "where",
      label: "Where things are",
      icon: "assets/orders.svg",
      href: "info.html?category=where",
    },
    {
      id: "instructions",
      label: "Instructions",
      icon: "assets/assignment.svg",
      href: "info.html?category=instructions",
    },
  ],

  categories: {
    preferences: { title: "Preferences" },
    where: { title: "Where things are" },
    instructions: { title: "Instructions" },
  },

  allergies: {
    title: "Food & allergies",
    sectionTitle: "Dietary restrictions",
    careNote:
      "Epinephrine auto-injector (EpiPen) available in bathroom cabinet for use in the event of a severe allergic reaction.",
    items: [
      {
        name: "Gluten-free",
        severity: "Severe",
        severityClass: "badge--severe",
        image: "assets/gluten.png",
        description:
          "Avoid wheat, barley, and rye. Use separate utensils; check food labels.",
      },
      {
        name: "Dairy-free",
        severity: "Mild",
        severityClass: "badge--mild",
        image: "assets/dairy.png",
        description:
          "Avoid milk, cheese, and butter. Serve dairy-free alternatives.",
      },
      {
        name: "Nut-free",
        severity: "Severe",
        severityClass: "badge--severe",
        image: "assets/nuts.png",
        description:
          "Avoid nuts and nut traces. Follow the child’s allergy care plan.",
      },
    ],
  },
};
