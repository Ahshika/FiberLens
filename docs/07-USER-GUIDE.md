# دليل الاستخدام — User Guide

## 1. أول تشغيل / First launch
1. أنشئ حساب المدير (Admin) — الحسابات محفوظة على الجهاز وتعمل بدون إنترنت.
2. اضغط **Open DWG / DXF** واختر الملف. يتم حفظ الملف الأصلي **للقراءة فقط**، وكل التعديلات تتم على
   نسخة المشروع (File safety).
3. المشروع يظهر في قائمة المشاريع ويمكن فتحه لاحقًا بدون إنترنت.

## 2. الشاشة / Screen
* **أعلى:** اسم المشروع، وضع Design / As-Built، حالة الـGPS والدقة، الإحداثيات، Undo / Redo، حفظ إصدار، الخصائص.
* **الوسط:** ملف الـCAD نفسه (الخريطة الأساسية).
* **أسفل:** Layers · Draw · Edit · Text · FTTH · Search · Measure · GPS · Survey · Notes · Photos · More.
* **اللمس:** إصبع واحد = تحريك، إصبعين = Zoom، ضغطة = اختيار، ضغطة مطولة + سحب = اختيار بنافذة.
* **الماوس:** العجلة = Zoom، الزر الأوسط/الأيمن = تحريك، السحب يمين/يسار = Window/Crossing.
* **لوحة المفاتيح:** Del حذف · Ctrl+Z/Y · Esc · Enter · F3 Snap · F7 Grid · F8 Ortho.

## 3. GPS داخل الـCAD
1. افتح **GPS** واضغط **Start** (أو زر ◎ في الشاشة).
2. لو الملف مرسوم بإحداثيات UTM / الأحزمة المصرية: اضغط **Auto-detect CRS** — البرنامج يحدد النظام تلقائيًا من موقعك.
3. لو الملف بإحداثيات محلية: افتح **Calibration Wizard**:
   1. Pick CAD point (اختر نقطة معروفة على الرسم — يوجد Snap للأركان والبلوكات).
   2. Use my GPS position (قف على النقطة — يتم أخذ متوسط 10 قراءات) أو اكتب الإحداثيات.
   3. كرر لنقطتين على الأقل (Helmert) أو 3 (Affine).
   4. راجع الـResiduals والـRMS ثم **Save calibration**.
4. يظهر **📍 YOU ARE HERE** داخل الرسم ويتحرك معك. اضغط ◎ مرة ثانية لوضع **Follow me**؛ واختر North up / Heading up.
5. **Tracking:** GPS → Start tracking → Stop & save (تصدير GPX).
6. أجهزة GNSS/RTK خارجية: استخدم تطبيق الجهاز مع Android Mock Location ثم Phone GNSS، أو USB/Serial، أو Bluetooth LE.

## 4. الرسم والتعديل
* **Draw:** اختر الأداة ثم اضغط النقاط على الرسم. يمكن كتابة القيم في شريط الأوامر: `x,y` أو `@dx,dy` أو `@50<30` أو طول فقط.
* اختر اللون بحرية من الدائرة الملونة، والطبقة، ونوع الخط، والسمك، والشفافية، والتعبئة.
* **Edit:** اختر العناصر ثم الأمر (Move, Copy, Rotate, Mirror, Scale, Stretch, Trim, Extend, Offset, Fillet, Chamfer, Explode, Join, Break, PEdit…).
* **Grips:** اضغط على المربع الأزرق لعنصر مختار ثم المكان الجديد.
* **Text:** Text / MText جديد، أو **Edit text** ثم اضغط أي كتابة أو Attribute داخل الـDWG لتعديلها.
* **Properties:** تعديل الطبقة واللون والخط والسمك والشفافية والإحداثيات لأي عنصر.

## 5. FTTH
1. **FTTH → Detect:** اختر Visible area أو Inside selected boundary، ثم Run detection → Apply.
   البرنامج يتعرف على FAT / FDT (X-BOX) / FDH (Hubbox) / Closures / OLT / Manholes والكابلات حسب أسماء الطبقات والبلوكات والـAttributes (القواعد قابلة للتعديل).
2. اضغط أي عنصر على الرسم لرؤية بطاقته: الحالة، الخصائص، الكابلات، الصور، الملاحظات، الصيانة.
3. **Trace to OLT** / **Trace downstream**: يتم تلوين المسار على الرسم وعرض الخطوات والأطوال.
4. **Cable card:** النوع، عدد الشعيرات، الطول (يتحدث تلقائيًا لو تغير المسار)، From/To، وجدول الشعيرات بألوان TIA-598 (Used / Spare / Reserved / Damaged / Available).
5. **Splitters:** 1:2 … 1:64 مع ربط كل Port بكابل/شعيرة/عميل.
6. **Draw cable / Place object / Link CAD → FTTH** لإضافة عناصر جديدة.
7. **Search:** اكتب `FTB-023` أو `FAT-027` أو رقم كابل أو اسم عميل → Zoom مباشرة.
8. **Navigate:** أقرب عنصر يظهر أعلى الشاشة؛ اضغط Navigate لعرض الاتجاه والمسافة فوق الرسم.

## 6. العمل الميداني
* **Survey:** Start survey session ثم أضف GPS point / Photo / Video / Voice / Note / FTTH object / Damage / Inspection / Installation — كل عنصر يُحفظ بموقعه ووقته.
* **Photos:** كل صورة مرتبطة بالعنصر وموقع GPS ووقت التصوير.
* **Notes:** ملاحظة مثبتة على مكان في الرسم مع الحالة (Open / Pending / Resolved).
* **Maintenance & Faults:** سجل الصيانة لكل عنصر، وبلاغ عطل مع Trace لمعرفة المسار المحتمل والعملاء المتأثرين.
* **QR:** إنشاء QR لكل عنصر أو صفحة ملصقات A4؛ مسح الـQR يفتح بطاقة العنصر مباشرة.

## 7. As-Built والإصدارات
* Project → **As-Built** لتسجيل التنفيذ الفعلي (يتم حفظ إصدار Design أولًا).
* **Versions:** حفظ V1, V2, … أو As-Built مع التاريخ والمستخدم وملخص التغييرات؛ يمكن الرجوع لأي إصدار.
* **Design vs As-Built:** مقارنة على الرسم (أخضر = مضاف، برتقالي = معدل، أحمر = محذوف) وعلى بيانات FTTH.

## 8. التصدير والتقارير
* **Export:** DWG (مع الحفاظ على بيانات الملف الأصلي)، DXF، PDF، PNG، JPG، CSV، Excel، GeoJSON، KML، KMZ.
* **Reports & BOQ:** الكميات (الكابلات حسب النوع، العناصر، الـSplitters) + 10 تقارير بصيغة Excel / PDF / CSV.

## 9. المستخدمين والأمان
* Roles: Admin · Engineer · Designer · Field Technician · Viewer (مع صلاحيات لكل مشروع).
* Audit log لكل العمليات، نسخ احتياطي مشفر (AES-256)، ومزامنة سحابية اختيارية عند توفر الإنترنت.
