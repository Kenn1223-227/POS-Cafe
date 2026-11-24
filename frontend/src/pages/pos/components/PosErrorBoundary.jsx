import React from 'react'

export default class PosErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, errorMessage: '' }
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message || 'Đã xảy ra lỗi hiển thị cục bộ.',
    }
  }

  componentDidCatch(error, info) {
    if (typeof console !== 'undefined' && console.error) {
      console.error(`[PosErrorBoundary:${this.props.section || 'POS'}]`, error, info)
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: '' })
    if (typeof this.props.onReset === 'function') {
      this.props.onReset()
    }
  }

  render() {
    if (this.state.hasError) {
      const section = this.props.section || 'Khu vực bán hàng'
      return (
        <div
          role="alert"
          className="flex flex-col items-center justify-center p-5 m-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 text-center min-h-[140px]"
        >
          <p className="font-semibold text-sm mb-1">
            ⚠️ {section} gặp sự cố tạm thời
          </p>
          <p className="text-xs text-amber-800 mb-3 max-w-md break-words">
            {this.state.errorMessage}
          </p>
          <button
            type="button"
            onClick={this.handleReset}
            className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium cursor-pointer"
          >
            Tải lại khu vực này
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
