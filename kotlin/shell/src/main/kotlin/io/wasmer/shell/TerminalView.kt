package io.wasmer.shell

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.InputType
import android.view.*
import android.view.inputmethod.*
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max

class TerminalView(context: Context) : View(context) {
    private var handle = Ghostty.create(80, 24).also { check(it != 0L) { "Unable to create Ghostty terminal" } }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.MONOSPACE; textSize = 13 * resources.displayMetrics.scaledDensity
    }
    private val cellWidth get() = paint.measureText("M")
    private val cellHeight get() = paint.fontSpacing
    var columns = 80; private set
    var rows = 24; private set
    var onInput: (ByteArray) -> Unit = {}
    var onResize: (Int, Int) -> Unit = { _, _ -> }
    private var touchY = 0f
    private var moved = false
    init {
        isFocusable = true; isFocusableInTouchMode = true
        contentDescription = "Wasmer terminal"
        setBackgroundColor(0xff0c0c12.toInt())
    }
    fun feed(bytes: ByteArray) {
        if (handle == 0L) return
        Ghostty.feed(handle, bytes)
        val response = Ghostty.responses(handle)
        if (response.isNotEmpty()) onInput(response)
        postInvalidateOnAnimation()
    }
    fun key(key: Int) { if (handle != 0L) input(Ghostty.key(handle, key)) }
    fun input(bytes: ByteArray) {
        if (handle == 0L) return
        Ghostty.bottom(handle); onInput(bytes); invalidate()
    }
    fun keyboard() {
        requestFocus()
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }
    fun close() { if (handle != 0L) { Ghostty.destroy(handle); handle = 0 } }
    fun screenText(): String {
        if (handle == 0L) return ""
        val text = StringBuilder()
        cells { _, _, _, _, _, _, value -> text.append(value) }
        return text.toString()
    }
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        columns = max(2, (w / cellWidth).toInt()).coerceAtMost(65535)
        rows = max(2, (h / cellHeight).toInt()).coerceAtMost(65535)
        if (handle != 0L && Ghostty.resize(handle, columns, rows)) onResize(columns, rows)
    }
    private fun cells(draw: (Int, Int, Int, Int, Int, Int, String) -> Unit): IntArray? {
        val bytes = Ghostty.frame(handle)
        if (bytes.size < 24) return null
        val data = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val header = IntArray(6) { data.int }
        repeat(header[5]) {
            val x = data.int; val y = data.int; val fg = data.int; val bg = data.int
            val width = data.int; val flags = data.int
            val text = ByteArray(data.int); data.get(text)
            draw(x, y, fg, bg, width, flags, text.decodeToString())
        }
        return header
    }
    override fun onDraw(canvas: Canvas) {
        if (handle == 0L) return
        val header = cells { column, row, fg, bg, width, flags, text ->
            val x = column * cellWidth; val y = row * cellHeight
            paint.color = bg or 0xff000000.toInt()
            canvas.drawRect(x, y, x + cellWidth, y + cellHeight, paint)
            if (width > 0) {
                paint.color = fg or 0xff000000.toInt()
                paint.isFakeBoldText = flags and 1 != 0
                paint.textSkewX = if (flags and 2 != 0) -0.2f else 0f
                paint.isUnderlineText = flags and 4 != 0
                paint.isStrikeThruText = flags and 8 != 0
                canvas.drawText(text, x, y - paint.fontMetrics.ascent, paint)
                paint.isFakeBoldText = false; paint.textSkewX = 0f
                paint.isUnderlineText = false; paint.isStrikeThruText = false
            }
        } ?: return
        if (header[2] != 0) {
            paint.color = 0x99a78bfa.toInt()
            val x = header[0] * cellWidth; val y = header[1] * cellHeight
            canvas.drawRect(x, y, x + cellWidth, y + cellHeight, paint)
        }
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (handle == 0L) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { touchY = event.y; moved = false; return true }
            MotionEvent.ACTION_MOVE -> {
                val delta = ((touchY - event.y) / cellHeight).toInt()
                if (delta != 0) { Ghostty.scroll(handle, delta); touchY = event.y; moved = true; invalidate() }
            }
            MotionEvent.ACTION_UP -> if (!moved) performClick()
        }
        return true
    }
    override fun performClick(): Boolean { super.performClick(); keyboard(); return true }
    override fun onCheckIsTextEditor() = true
    override fun onCreateInputConnection(info: EditorInfo): InputConnection {
        info.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        info.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_NONE
        return object : BaseInputConnection(this, false) {
            private var composing = ""
            override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
                composing = text?.toString().orEmpty(); return true
            }
            override fun finishComposingText(): Boolean {
                if (composing.isNotEmpty()) input(composing.encodeToByteArray())
                composing = ""; return true
            }
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                composing = ""; input(text?.toString().orEmpty().encodeToByteArray()); return true
            }
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                composing = ""; repeat(beforeLength.coerceIn(0, 1024)) { key(4) }; return true
            }
            override fun sendKeyEvent(event: KeyEvent): Boolean =
                if (event.action == KeyEvent.ACTION_DOWN) onKeyDown(event.keyCode, event) else true
        }
    }
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val key = when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> 0; KeyEvent.KEYCODE_DPAD_DOWN -> 1
            KeyEvent.KEYCODE_DPAD_LEFT -> 2; KeyEvent.KEYCODE_DPAD_RIGHT -> 3
            KeyEvent.KEYCODE_DEL -> 4; KeyEvent.KEYCODE_ENTER -> 5
            KeyEvent.KEYCODE_TAB -> 6; KeyEvent.KEYCODE_ESCAPE -> 7
            else -> null
        }
        if (key != null) { key(key); return true }
        val code = event.getUnicodeChar(event.metaState and KeyEvent.META_CTRL_MASK.inv())
        if (code != 0 && code and KeyCharacterMap.COMBINING_ACCENT == 0) {
            if (event.isCtrlPressed && code in 64..127) input(byteArrayOf((code and 31).toByte()))
            else input(String(Character.toChars(code)).encodeToByteArray())
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
